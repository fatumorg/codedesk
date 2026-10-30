{
  description = "Codedesk - a desktop workspace for Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      forAll = f: lib.genAttrs [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ]
        (s: f nixpkgs.legacyPackages.${s});
    in {
      packages = forAll (pkgs:
        let
          lock = builtins.fromJSON (builtins.readFile ./package-lock.json);
          deps = lib.filterAttrs (k: v: k != "" && !(v.dev or false) && !(v.optional or false)) lock.packages;
          app = "$out/share/codedesk";
          desktop = pkgs.makeDesktopItem {
            name = "codedesk";
            desktopName = "Codedesk";
            exec = "codedesk %U";
            icon = "codedesk";
            categories = [ "Development" ];
            startupWMClass = "codedesk";
            comment = "Desktop workspace for Claude Code";
          };
        in {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "codedesk";
            version = lock.version;
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [ ./main.mjs ./agy.mjs ./accounts.mjs ./remote.mjs ./preload.cjs ./ui ./build ./vendor ./package.json ];
            };
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              mkdir -p ${app} $out/bin $out/share/applications
              cp -r . ${app}
              ${lib.concatStrings (lib.mapAttrsToList (path: v: ''
                mkdir -p ${app}/${path}
                tar xzf ${pkgs.fetchurl { url = v.resolved; hash = v.integrity; }} --strip-components=1 -C ${app}/${path}
              '') deps)}
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/codedesk --add-flags ${app}
              cp ${desktop}/share/applications/* $out/share/applications/
              install -Dm644 build/icon.svg $out/share/icons/hicolor/scalable/apps/codedesk.svg
              install -Dm644 build/icon.png $out/share/icons/hicolor/512x512/apps/codedesk.png
            '';
            meta.mainProgram = "codedesk";
          };
        });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs pkgs.electron ];
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          shellHook = "alias start='electron .'";
        };
      });
    };
}
