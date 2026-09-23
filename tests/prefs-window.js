import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import Gtk from 'gi://Gtk';

import {programArgs} from 'system';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function descendants(widget) {
    const result = [];
    for (let child = widget.get_first_child(); child;
        child = child.get_next_sibling()) {
        result.push(child, ...descendants(child));
    }
    return result;
}

function takeWidgetScreenshot(widget, path) {
    const width = widget.get_width();
    const height = widget.get_height();
    const paintable = new Gtk.WidgetPaintable({widget});
    const snapshot = new Gtk.Snapshot();
    paintable.snapshot(snapshot, width, height);
    const node = snapshot.to_node();
    assert(node, 'preferences screenshot did not produce a render node');

    const bounds = new Graphene.Rect();
    bounds.init(0, 0, width, height);
    const renderer = Gsk.Renderer.new_for_surface(widget.get_surface());
    const texture = renderer.render_texture(node, bounds);
    assert(texture instanceof Gdk.Texture && texture.save_to_png(path),
        'preferences screenshot could not be saved');
    renderer.unrealize();
}

imports.package.init({
    name: 'gnome-shell',
    prefix: '/usr',
    libdir: '/usr/lib64',
});
const extensionsResource = Gio.Resource.load(
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(extensionsResource);

const extensionPath = programArgs[0] ?? GLib.build_filenamev([
    GLib.get_user_data_dir(),
    'gnome-shell',
    'extensions',
    'lyric-glance@eureka',
]);
const metadataPath = GLib.build_filenamev([extensionPath, 'metadata.json']);
const [ok, metadataContents] = GLib.file_get_contents(metadataPath);
assert(ok, 'the installed extension metadata could not be read');
const metadata = JSON.parse(new TextDecoder().decode(metadataContents));
assert(metadata.url === 'https://github.com/eurekaevan/lyric-glance' &&
    metadata['gettext-domain'] === 'lyric-glance@eureka' &&
    !Object.hasOwn(metadata, 'version'),
'preferences should load release metadata without deprecated version');
const directory = Gio.File.new_for_path(extensionPath);
const effectiveLocale = GLib.getenv('LC_ALL') ??
    GLib.getenv('LANGUAGE') ?? GLib.getenv('LANG') ?? '';
const simplifiedChinese = effectiveLocale.startsWith('zh_CN');
const uiText = (english, chinese) => simplifiedChinese ? chinese : english;

const application = new Adw.Application({
    application_id: 'org.gnome.Shell.Extensions.LyricGlancePrefsTest',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
let scenarioError = null;

application.connect('activate', async app => {
    app.hold();
    try {
        const module = await import(directory.get_child('prefs.js').get_uri());
        const preferences = new module.default({
            ...metadata,
            dir: directory,
            path: extensionPath,
        });
        const screenshotPath = GLib.getenv(
            'LYRIC_GLANCE_PREFS_SCREENSHOT_PATH');
        const window = new Adw.PreferencesWindow({
            application: app,
            title: metadata.name,
            default_height: screenshotPath ? 900 : -1,
        });
        await preferences.fillPreferencesWindow(window);
        window.present();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
            try {
                assert(window.get_visible_page(),
                    'the preferences window did not provide a visible page');
                const widgets = descendants(window);
                const visibleTitle = window.get_visible_page().title;
                assert(visibleTitle === uiText('General', '常规'),
                    `preferences page title was ${JSON.stringify(visibleTitle)}`);
                assert(widgets.some(widget =>
                    widget instanceof Adw.PreferencesGroup &&
                    widget.title === uiText('Panel', '顶栏')),
                'preferences should translate group titles');
                assert(widgets.some(widget =>
                    widget instanceof Adw.SwitchRow &&
                    widget.title === uiText('Enable translation', '启用翻译')),
                'preferences should translate setting rows');
                assert(widgets.filter(widget => widget instanceof Adw.SwitchRow)
                    .length === 6,
                'preferences should contain six boolean SwitchRows');
                assert(widgets.filter(widget => widget instanceof Adw.SpinRow)
                    .length === 2,
                'preferences should contain width and global-offset SpinRows');
                assert(widgets.filter(widget => widget instanceof Adw.ComboRow)
                    .length === 3,
                'preferences should expose position, popup, and panel choices');
                assert(widgets.filter(widget => widget instanceof Adw.EntryRow)
                    .length === 3,
                'preferences should expose target-language, endpoint, and model entries');
                const endpointRow = widgets.find(widget =>
                    widget instanceof Adw.EntryRow &&
                    widget.title === uiText(
                        'Responses API endpoint', 'Responses API 端点'));
                const modelRow = widgets.find(widget =>
                    widget instanceof Adw.EntryRow &&
                    widget.title === uiText('Model', '模型'));
                const applyButton = widgets.find(widget =>
                    widget instanceof Gtk.Button &&
                    widget.label === uiText('Apply', '应用'));
                assert(endpointRow && modelRow && applyButton,
                'preferences should expose the configurable translation backend');
                if (screenshotPath)
                    takeWidgetScreenshot(window, screenshotPath);
                const settings = preferences.getSettings();
                endpointRow.text = 'https://proxy.example/v1/responses';
                modelRow.text = 'custom-translation-model';
                applyButton.emit('clicked');
                assert(settings.get_string('translation-api-endpoint') ===
                    endpointRow.text &&
                    settings.get_string('translation-model') === modelRow.text,
                'applying the translation backend should persist both values');
                endpointRow.text = 'http://proxy.example/v1/responses';
                applyButton.emit('clicked');
                assert(settings.get_string('translation-api-endpoint') ===
                    'https://proxy.example/v1/responses',
                'an insecure remote endpoint should not replace saved settings');
                endpointRow.text = 'https://api.openai.com/v1/responses';
                modelRow.text = 'gpt-5.4-mini-2026-03-17';
                applyButton.emit('clicked');
                print('GTK4/Libadwaita preferences window test passed');
                window.close();
                app.release();
                app.quit();
            } catch (error) {
                scenarioError = error;
                logError(error);
                app.release();
                app.quit();
            }
            return GLib.SOURCE_REMOVE;
        });
    } catch (error) {
        scenarioError = error;
        logError(error);
        app.release();
        app.quit();
    }
});

const status = application.run([]);
Gio.resources_unregister(extensionsResource);
if (scenarioError)
    throw scenarioError;
if (status !== 0)
    throw new Error(`preferences application exited with status ${status}`);
