import Gio from 'gi://Gio';
import St from 'gi://St';

export function animationsEnabled() {
    const settings = St.Settings.get();
    return settings.enable_animations &&
        (!St.ReducedMotion || settings.reduced_motion !== St.ReducedMotion.REDUCE);
}

export function musicIcon() {
    return Gio.ThemedIcon.new_from_names([
        'music-note-symbolic',
        'audio-x-generic-symbolic',
        'media-playback-start-symbolic',
    ]);
}
