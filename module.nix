# NixOS module for the Super Chat server.
#
# Like super-badger's module, the server is built by an activation script
# rather than a buildGoModule derivation: keeping a vendorHash in sync by hand
# on every go.sum change costs more than it's worth for a binary with no
# reproducibility requirement. It rebuilds from ${self}/server on every
# activation; goCache keeps that fast after the first run. The optional web
# client follows the same tradeoff via npmCache.
{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.superchat;
  stateDir = "/var/lib/superchat";
  serverBin = "${stateDir}/bin/superchat-server";
  adminBin = "${stateDir}/bin/superchat-admin";
  goCache = "/var/cache/superchat-go";
  npmCache = "/var/cache/superchat-npm";
  webDir = "${stateDir}/web";

  # `superchat-admin stats` etc. against the running service's database.
  adminWrapper = pkgs.writeShellScriptBin "superchat-admin" ''
    export SUPERCHAT_DATA_DIR="${cfg.dataDir}"
    exec ${pkgs.sudo}/bin/sudo -u superchat -E ${adminBin} "$@"
  '';
in
{
  # Voice uses only the STUN/TURN servers each device has in Settings → Voice;
  # the server no longer hands out relay credentials.
  imports = [
    (lib.mkRemovedOptionModule [ "services" "superchat" "turn" ]
      "Super Chat no longer serves TURN credentials; add STUN/TURN servers in the app's Settings → Voice (or share one in a chat).")
  ];

  options.services.superchat = {
    enable = lib.mkEnableOption "the Super Chat end-to-end encrypted chat server";

    listenAddr = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:8080";
      description = ''
        Address for the API to listen on. Loopback by default: put a tunnel
        (cloudflared) or reverse proxy in front of it for TLS.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${stateDir}/data";
      description = "Where the SQLite database and encrypted blobs live.";
    };

    publicOrigin = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://chat.superbadger.io";
      description = "The public https origin invite links point at.";
    };

    androidCertSha256 = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "AB:CD:…" ];
      description = ''
        SHA-256 fingerprints of the APK signing key, served in
        /.well-known/assetlinks.json so invite links open straight in the app.
        Get it with `keytool -list -v -keystore release/release.keystore`.
      '';
    };

    maxBlobMB = lib.mkOption {
      type = lib.types.ints.positive;
      default = 25;
      description = "Largest encrypted attachment accepted, in MB.";
    };

    trustProxy = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Rate-limit by the client address a local tunnel (Pangolin/newt,
        cloudflared) reports: the rightmost X-Forwarded-For entry, believed
        only on loopback connections, so clients can't forge it. Turn off if
        clients connect to the server directly.
      '';
    };

    web = {
      enable = lib.mkEnableOption "serving the app's web client on its own port";
      listenAddr = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1:8081";
        description = "Address for the static web client.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.superchat = {
      isSystemUser = true;
      group = "superchat";
      home = stateDir;
    };
    users.groups.superchat = { };

    systemd.tmpfiles.rules = [
      "d ${stateDir} 0750 superchat superchat -"
      "d ${stateDir}/bin 0755 root root -"
      "d ${cfg.dataDir} 0700 superchat superchat -"
      "d ${goCache} 0755 root root -"
    ] ++ lib.optionals cfg.web.enable [
      "d ${npmCache} 0755 root root -"
    ];

    system.activationScripts.superchatBuild = {
      deps = [ ];
      text = ''
        export PATH=${pkgs.go}/bin:${pkgs.bash}/bin:${pkgs.nodejs_22}/bin:$PATH
        export HOME=${goCache}
        export GOCACHE=${goCache}/build
        export GOPATH=${goCache}/path
        # modernc sqlite is pure Go; no C toolchain needed.
        export CGO_ENABLED=0
        mkdir -p ${stateDir}/bin ${goCache}
        cd ${self}/server
        ${pkgs.go}/bin/go build -buildvcs=false -o ${serverBin}.new ./cmd/superchat-server
        mv -f ${serverBin}.new ${serverBin}
        ${pkgs.go}/bin/go build -buildvcs=false -o ${adminBin}.new ./cmd/superchat-admin
        mv -f ${adminBin}.new ${adminBin}
      '' + lib.optionalString cfg.web.enable ''
        # ${self}/app is in the read-only store and npm ci writes
        # node_modules into the project, so build from a scratch copy.
        export npm_config_cache=${npmCache}
        appBuild=${stateDir}/app-build
        rm -rf "$appBuild"
        mkdir -p "$appBuild"
        cp -r ${self}/app/. "$appBuild"/
        chmod -R u+w "$appBuild"
        cd "$appBuild"
        ${pkgs.nodejs_22}/bin/npm ci
        ${pkgs.nodejs_22}/bin/npm run build:web
        rm -rf ${webDir}.new
        cp -r dist ${webDir}.new
        chown -R superchat:superchat ${webDir}.new
        rm -rf ${webDir}
        mv -f ${webDir}.new ${webDir}
      '' + ''
        ${pkgs.systemd}/bin/systemctl try-restart superchat.service || true
      '';
    };

    environment.systemPackages = [ adminWrapper ];

    systemd.services.superchat = {
      description = "Super Chat server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        SUPERCHAT_LISTEN_ADDR = cfg.listenAddr;
        SUPERCHAT_DATA_DIR = cfg.dataDir;
        SUPERCHAT_PUBLIC_ORIGIN = cfg.publicOrigin;
        SUPERCHAT_ANDROID_CERT_SHA256 = lib.concatStringsSep "," cfg.androidCertSha256;
        SUPERCHAT_MAX_BLOB_MB = toString cfg.maxBlobMB;
        SUPERCHAT_TRUST_PROXY = if cfg.trustProxy then "1" else "0";
      } // lib.optionalAttrs cfg.web.enable {
        SUPERCHAT_STATIC_DIR = webDir;
        SUPERCHAT_STATIC_LISTEN_ADDR = cfg.web.listenAddr;
      };
      serviceConfig = {
        ExecStart = serverBin;
        Restart = "always";
        RestartSec = 2;
        User = "superchat";
        Group = "superchat";
        # The server holds only ciphertext, but lock it down anyway.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        CapabilityBoundingSet = "";
        UMask = "0077";
      };
    };
  };
}
