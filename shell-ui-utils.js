import Gio from 'gi://Gio';
import St from 'gi://St';

export function animationsEnabled() {
    const settings = St.Settings.get();
    return settings.enable_animations &&
        (!St.ReducedMotion || settings.reduced_motion !== St.ReducedMotion.REDUCE);
}

export function musicIcon() {
    const file = Gio.File.new_for_uri(import.meta.url).get_parent()
        .get_child('icons').get_child('lyric-glance-symbolic.svg');
    return new Gio.FileIcon({file});
}
