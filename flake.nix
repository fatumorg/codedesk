{
  description = "Codedesk - a desktop workspace for Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      forAll = f: lib.genAttrs [ "x86_64-linux" "aarch64-linux" ]
        (s: f nixpkgs.legacyPackages.${s});
    in {
      packages = forAll (pkgs:
        let
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
          default = pkgs.rustPlatform.buildRustPackage {
            pname = "codedesk";
            version = (lib.importTOML ./Cargo.toml).package.version;
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./build.rs ./tauri.conf.json ./capabilities ./src ./ui ];
            };
            cargoLock.lockFile = ./Cargo.lock;
            nativeBuildInputs = with pkgs; [ pkg-config wrapGAppsHook3 rustPlatform.bindgenHook ];
            buildInputs = with pkgs; [ webkitgtk_4_1 gtk3 libsoup_3 glib-networking openssl libxkbcommon libxcb xorg.libX11 xorg.libXtst xorg.libXi xorg.libXrandr wayland dbus pipewire libgbm libdrm ];
            doCheck = false;
            postInstall = ''
              install -Dm644 ${desktop}/share/applications/codedesk.desktop $out/share/applications/codedesk.desktop
              install -Dm644 ui/icons/icon.svg $out/share/icons/hicolor/scalable/apps/codedesk.svg
              install -Dm644 ui/icons/icon.png $out/share/icons/hicolor/512x512/apps/codedesk.png
            '';
            meta.mainProgram = "codedesk";
          };
        });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [ rustc cargo clippy rustfmt pkg-config wrapGAppsHook3 cargo-tauri xdotool xorg.xorgserver imagemagick nodejs ];
          buildInputs = with pkgs; [ webkitgtk_4_1 gtk3 libsoup_3 glib-networking openssl libxkbcommon libxcb xorg.libX11 xorg.libXtst xorg.libXi xorg.libXrandr wayland dbus pipewire libgbm libdrm ];
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
        };
      });
    };
}
