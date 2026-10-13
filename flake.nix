{
  description = "Super Chat: end-to-end encrypted rooms. Dev shell + NixOS module";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      perSystem = flake-utils.lib.eachDefaultSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # $PWD is resolved at runtime, so these scripts must be run from the
          # repo root (always `cd` into super-chat/ before `nix develop`).
          repoRoot = "$PWD";
          dataDir = "${repoRoot}/.data";
          listenAddr = "127.0.0.1:8080";

          db-reset = pkgs.writeShellScriptBin "db-reset" ''
            set -e
            rm -rf "${dataDir}"
            echo "removed ${dataDir} (a fresh database is created on next start)"
          '';

          # foreground, hot-reload via air (see server/.air.toml)
          run-superchat = pkgs.writeShellScriptBin "run-superchat" ''
            set -e
            mkdir -p "${dataDir}"
            cd "${repoRoot}/server"
            export SUPERCHAT_LISTEN_ADDR="${listenAddr}"
            export SUPERCHAT_DATA_DIR="${dataDir}"
            export SUPERCHAT_PUBLIC_ORIGIN="http://${listenAddr}"
            exec ${pkgs.air}/bin/air
          '';

          dev-up = pkgs.writeShellScriptBin "dev-up" ''
            set -e
            data_dir="$PWD/.data"
            mkdir -p "$data_dir/logs"
            (cd "${repoRoot}/server" && \
              SUPERCHAT_LISTEN_ADDR="${listenAddr}" \
              SUPERCHAT_DATA_DIR="$data_dir" \
              SUPERCHAT_PUBLIC_ORIGIN="http://${listenAddr}" \
              ${pkgs.go}/bin/go run ./cmd/superchat-server > "$data_dir/logs/superchat.log" 2>&1 &)
            echo "superchat: http://${listenAddr} (log: $data_dir/logs/superchat.log)"
            echo "run 'dev-down' to stop it"
          '';

          dev-down = pkgs.writeShellScriptBin "dev-down" ''
            pkill -f "cmd/superchat-server" 2>/dev/null || true
            pkill -f "go-build.*superchat" 2>/dev/null || true
            pkill -f "tmp/superchat-server" 2>/dev/null || true
            echo "stopped superchat (best-effort)"
          '';

          # Same database as the dev server above.
          superchat-admin = pkgs.writeShellScriptBin "superchat-admin" ''
            set -e
            cd "${repoRoot}/server"
            export SUPERCHAT_DATA_DIR="${dataDir}"
            exec ${pkgs.go}/bin/go run ./cmd/superchat-admin "$@"
          '';

          run-app-web = pkgs.writeShellScriptBin "run-app-web" ''
            set -e
            cd "${repoRoot}/app"
            exec ${pkgs.nodejs_22}/bin/npm run web
          '';

          run-app-web-build = pkgs.writeShellScriptBin "run-app-web-build" ''
            set -e
            cd "${repoRoot}/app"
            exec ${pkgs.nodejs_22}/bin/npm run build:web
          '';

          # Needs the system-wide Android SDK already on this machine's PATH;
          # nothing Android-related is added to this flake on purpose.
          run-app-android = pkgs.writeShellScriptBin "run-app-android" ''
            set -e
            cd "${repoRoot}/app"
            exec ${pkgs.nodejs_22}/bin/npm run android
          '';

          # Regenerates the logo data and launcher icons from art/.
          run-appart = pkgs.writeShellScriptBin "run-appart" ''
            set -e
            cd "${repoRoot}/tools"
            exec ${pkgs.go}/bin/go run ./appart "$@"
          '';

          run-tests = pkgs.writeShellScriptBin "run-tests" ''
            set -e
            (cd "${repoRoot}/server" && ${pkgs.go}/bin/go test ./...)
            (cd "${repoRoot}/app" && ${pkgs.nodejs_22}/bin/npx jest)
            (cd "${repoRoot}/app" && E2E=1 ${pkgs.nodejs_22}/bin/npx jest __tests__/e2e.test.ts --forceExit)
          '';

          printHelp = ''
            echo "super-chat dev shell"
            echo "  run-superchat     # foreground: the server with hot reload (air) on ${listenAddr}"
            echo "  dev-up / dev-down # start/stop the server headless (logs in .data/logs)"
            echo "  db-reset          # delete the local database and blobs"
            echo "  superchat-admin   # stats | delete-room <room>"
            echo "  run-app-web       # the app's web target via Vite on :5173"
            echo "  run-app-web-build # builds app/dist, what services.superchat.web serves"
            echo "  run-app-android   # the app on a connected device/emulator (needs the system Android SDK)"
            echo "  run-appart        # regenerate logo data + launcher icons from art/"
            echo "  run-tests         # server tests, app tests, then the end-to-end test"
            echo "  dev-help          # re-print this list"
          '';

          dev-help = pkgs.writeShellScriptBin "dev-help" printHelp;
        in
        {
          devShells.default = pkgs.mkShell {
            buildInputs = [
              pkgs.go
              pkgs.gopls
              pkgs.air
              pkgs.sqlite
              pkgs.nodejs_22
              pkgs.watchman
              db-reset
              run-superchat
              dev-up
              dev-down
              superchat-admin
              run-app-web
              run-app-web-build
              run-app-android
              run-appart
              run-tests
              dev-help
            ];
            shellHook = printHelp;
          };
        }
      );

      # No buildGoModule package on purpose, the same tradeoff as super-badger:
      # the module builds the server from source in an activation script
      # instead of keeping a vendorHash in sync by hand.
      nixosModules.default = import ./module.nix { inherit self; };
    in
    perSystem // { inherit nixosModules; };
}
