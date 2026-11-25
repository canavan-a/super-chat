package crypto

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"

	"github.com/canavan-a/super-chat/shared/proto"
	"github.com/canavan-a/super-chat/shared/wire"
)

// InviteLink is an invite: the server, the invite's ID and the secret that
// sits after the # (it never reaches the server).
type InviteLink struct {
	Server string
	Invite string
	Secret []byte
}

func inviteKey(secret []byte) ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(HKDF(secret, "invite-sign"))
}

func previewKey(secret []byte) []byte { return HKDF(secret, "invite-preview") }

// String is the https form: <server>/i/<id>#<secret>.
func (l InviteLink) String() string {
	return strings.TrimRight(l.Server, "/") + "/i/" + l.Invite + "#" + B64.EncodeToString(l.Secret)
}

var (
	httpsInvite  = regexp.MustCompile(`^(https?://[^/\s]+)/i/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$`)
	appInvite    = regexp.MustCompile(`^superchat://join\?(.+)$`)
	serverOrigin = regexp.MustCompile(`^https?://[^/\s]+$`)
)

// ParseInviteLink accepts https://server/i/<id>#<secret> and the app's
// superchat://join?s=…&i=…&k=… form, with surrounding space trimmed.
func ParseInviteLink(text string) (InviteLink, error) {
	s := strings.TrimSpace(text)
	if m := httpsInvite.FindStringSubmatch(s); m != nil {
		secret, err := B64.DecodeString(m[3])
		if err == nil {
			return InviteLink{Server: m[1], Invite: m[2], Secret: secret}, nil
		}
	}
	if m := appInvite.FindStringSubmatch(s); m != nil {
		params := map[string]string{}
		for _, kv := range strings.Split(m[1], "&") {
			k, v, _ := strings.Cut(kv, "=")
			if dv, err := url.PathUnescape(v); err == nil {
				params[k] = dv
			}
		}
		if serverOrigin.MatchString(params["s"]) && proto.IsID(params["i"]) && params["k"] != "" {
			if secret, err := B64.DecodeString(params["k"]); err == nil && len(secret) == 32 {
				return InviteLink{Server: params["s"], Invite: params["i"], Secret: secret}, nil
			}
		}
	}
	return InviteLink{}, errors.New("not an invite link")
}

// InvitePreview is what an invite shows before joining.
type InvitePreview struct {
	Name    string `json:"name"`
	Color   string `json:"color"`
	Inviter string `json:"inviter"`
}

// OpenPreview decrypts GET /v1/invites/:id's preview with the link's secret.
func OpenPreview(secret []byte, sealed string) (*InvitePreview, error) {
	raw, err := B64.DecodeString(sealed)
	if err != nil {
		return nil, err
	}
	plain, err := AEADOpen(previewKey(secret), raw, []byte("sc-preview"))
	if err != nil {
		return nil, err
	}
	var p InvitePreview
	if err := json.Unmarshal(plain, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// JoinProof is the invite key's signature admitting member to room.
func JoinProof(secret []byte, room, invite, member string) []byte {
	return ed25519.Sign(inviteKey(secret), proto.JoinProofMessage(room, invite, member))
}

// Join builds POST /v1/invites/:id/join on top of the room's verified state:
// our join (with the invite's proof), then a new epoch sealed to every member
// plus us (a joiner rotates the key itself), then our profile.
func Join(me *Member, s *proto.State, link InviteLink, preview *InvitePreview, displayName string, now int64) (*wire.Batch, *Epoch, error) {
	joined, s1, err := BuildEvents(me, s, []NewEvent{{
		Kind: "join",
		Pub: proto.JoinPub{
			Invite: link.Invite,
			Proof:  B64.EncodeToString(JoinProof(link.Secret, s.Room, link.Invite, me.ID)),
			X25519: B64.EncodeToString(me.XPub),
		},
	}}, now)
	if err != nil {
		return nil, nil, err
	}
	snap := Snapshot{Profiles: map[string]string{me.ID: displayName}}
	if preview != nil {
		snap.Name, snap.Color = preview.Name, preview.Color
	}
	ep, err := NewEpoch(s1, snap)
	if err != nil {
		return nil, nil, err
	}
	rest, _, err := BuildEvents(me, s1, []NewEvent{
		ep.Event,
		{Kind: "profile", Enc: Profile{DisplayName: displayName}, EncEpoch: ep.N, EncKey: ep.Key},
	}, now)
	if err != nil {
		return nil, nil, err
	}
	return &wire.Batch{Events: append(joined, rest...), Envelopes: ep.Envelopes}, ep, nil
}

// CreateInvite builds an invite event (admins only) and its link.
func CreateInvite(me *Member, s *proto.State, server string, preview InvitePreview, expiresAt int64, maxUses int, now int64) (InviteLink, *wire.Batch, error) {
	link := InviteLink{Server: server, Invite: proto.NewID(), Secret: RandomBytes(32)}
	signed, _, err := BuildEvents(me, s, []NewEvent{{
		Kind: "invite",
		Pub: proto.InvitePub{
			ID:        link.Invite,
			Key:       B64.EncodeToString(inviteKey(link.Secret).Public().(ed25519.PublicKey)),
			ExpiresAt: expiresAt,
			MaxUses:   maxUses,
		},
	}}, now)
	if err != nil {
		return InviteLink{}, nil, err
	}
	plain, err := marshal(preview)
	if err != nil {
		return InviteLink{}, nil, err
	}
	sealed := B64.EncodeToString(AEADSeal(previewKey(link.Secret), plain, []byte("sc-preview")))
	return link, &wire.Batch{Events: signed, Preview: sealed}, nil
}
