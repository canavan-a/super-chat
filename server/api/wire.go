package api

import (
	"main/database"

	"github.com/canavan-a/super-chat/shared/wire"
)

// Database rows → the wire types clients decode (shared/wire). Lists are
// never null, so clients can range over them as they are.

func wireEvent(e database.Event) wire.StoredEvent {
	return wire.StoredEvent{Seq: e.Seq, Hash: e.Hash, Body: e.Body, Sig: e.Sig}
}

func wireEvents(evs []database.Event) []wire.StoredEvent {
	out := make([]wire.StoredEvent, len(evs))
	for i, e := range evs {
		out[i] = wireEvent(e)
	}
	return out
}

func wireMessage(m database.Message) wire.Message {
	return wire.Message{Pos: m.Pos, ID: m.ID, Room: m.RoomID, Epoch: m.Epoch, Sender: m.Sender, Kind: m.Kind, Ct: m.Ct, CreatedAt: m.CreatedAt}
}

func wireMessages(ms []database.Message) []wire.Message {
	out := make([]wire.Message, len(ms))
	for i, m := range ms {
		out[i] = wireMessage(m)
	}
	return out
}

func wireEnvelopes(es []database.Envelope) []wire.StoredEnvelope {
	out := make([]wire.StoredEnvelope, len(es))
	for i, e := range es {
		out[i] = wire.StoredEnvelope{Epoch: e.Epoch, Sealed: e.Sealed}
	}
	return out
}
