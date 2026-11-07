import Gio from 'gi://Gio';

import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

export async function run() {
    await Scripting.sleep(1000);
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('WAYLAND_DISPLAY', 'gnome-shell-test-display', true);
    launcher.setenv('LC_ALL', 'C.UTF-8', true);
    const child = launcher.spawnv([
        'gjs', '-m', Gio.File.new_for_uri(import.meta.url).get_parent()
            .get_child('prefs-window.js').get_path(),
    ]);
    await child.wait_check_async(null);
    print('Isolated GTK preferences close, reopen and cleanup test passed');
}
