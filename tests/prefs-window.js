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
const traditionalChinese = effectiveLocale.startsWith('zh_TW');
const uiText = (english, chinese, traditional = chinese) =>
    traditionalChinese ? traditional : simplifiedChinese ? chinese : english;

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

        const checkPreferences = async () => {
            try {
                assert(window.get_visible_page(),
                    'the preferences window did not provide a visible page');
                const widgets = descendants(window);
                const visibleTitle = window.get_visible_page().title;
                assert(visibleTitle === uiText('General', '常规', '一般'),
                    `preferences page title was ${JSON.stringify(visibleTitle)}`);
                assert(widgets.some(widget =>
                    widget instanceof Adw.PreferencesGroup &&
                    widget.title === uiText('Panel', '顶栏', '頂欄')),
                'preferences should translate group titles');
                assert(widgets.some(widget =>
                    widget instanceof Adw.SwitchRow &&
                    widget.title === uiText('Enable translation', '启用翻译', '啟用翻譯')),
                'preferences should translate setting rows');
                assert(widgets.filter(widget => widget instanceof Adw.SwitchRow)
                    .length === 7,
                'preferences should contain seven boolean SwitchRows');
                assert(widgets.filter(widget => widget instanceof Adw.SpinRow)
                    .length === 2,
                'preferences should contain width and global-offset SpinRows');
                assert(widgets.filter(widget => widget instanceof Adw.ComboRow)
                    .length === 3,
                'preferences should expose position, popup, and panel choices');
                assert(widgets.filter(widget => widget instanceof Adw.EntryRow)
                    .length === 4,
                'preferences should expose translation and fallback endpoint entries');
                const lrcApiSwitch = widgets.find(widget => widget instanceof Adw.SwitchRow &&
                    widget.title === uiText('Use LrcAPI as a fallback',
                        '使用 LrcAPI 作为备用歌词源', '使用 LrcAPI 作為備用歌詞來源'));
                const lrcApiEndpoint = widgets.find(widget => widget instanceof Adw.EntryRow &&
                    widget.title === uiText('LrcAPI endpoint', 'LrcAPI 服务地址', 'LrcAPI 服務位址'));
                assert(lrcApiSwitch && lrcApiEndpoint && !lrcApiSwitch.active &&
                    !lrcApiEndpoint.sensitive, 'LrcAPI must default to disabled');
                lrcApiSwitch.active = true;
                assert(lrcApiEndpoint.sensitive, 'enabling LrcAPI should enable its endpoint editor');
                lrcApiEndpoint.text = 'http://example.test/jsonapi';
                lrcApiEndpoint.emit('apply');
                assert(lrcApiEndpoint.has_css_class('error'), 'insecure endpoints must be rejected');
                lrcApiEndpoint.text = 'http://127.0.0.1:28883/jsonapi';
                lrcApiEndpoint.emit('apply');
                assert(!lrcApiEndpoint.has_css_class('error') &&
                    preferences.getSettings().get_string('lrcapi-endpoint') === lrcApiEndpoint.text,
                'applying a loopback endpoint should persist it');
                lrcApiSwitch.active = false;
                const endpointRow = widgets.find(widget =>
                    widget instanceof Adw.EntryRow &&
                    widget.title === uiText(
                        'Responses API endpoint', 'Responses API 端点', 'Responses API 端點'));
                const modelRow = widgets.find(widget =>
                    widget instanceof Adw.EntryRow &&
                    widget.title === uiText('Model', '模型'));
                const applyButton = widgets.find(widget =>
                    widget instanceof Gtk.Button &&
                    widget.label === uiText('Apply', '应用', '套用'));
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
                const connectionButton = widgets.find(widget => widget instanceof Gtk.Button &&
                    widget.label === uiText('Check connection', '检查连通性', '檢查連線'));
                const connectionRow = widgets.find(widget => widget instanceof Adw.ActionRow &&
                    widget.title === uiText('Translation connection', '翻译连通性', '翻譯連線'));
                assert(connectionButton && connectionRow,
                    'preferences should expose the localized connection check');
                endpointRow.text = 'http://unsafe.example/v1/responses';
                connectionButton.emit('clicked');
                assert(connectionButton.sensitive && connectionRow.subtitle === uiText(
                    'Use HTTPS, or HTTP only for a local loopback endpoint',
                    '请使用 HTTPS；只有本机回环端点可以使用 HTTP',
                    '請使用 HTTPS；只有本機回送端點可以使用 HTTP'),
                'invalid check endpoints must be rejected before looking up credentials');

                const {TranslationCredentialStore} = await import(
                    directory.get_child('credentials.js').get_uri());
                const {OpenAITranslationProvider} = await import(
                    directory.get_child('translation-provider.js').get_uri());
                const originalLookup = TranslationCredentialStore.prototype.lookup;
                const originalCheck = OpenAITranslationProvider.prototype.checkConnection;
                let checkedRequest;
                let checkedModel;
                let failureCode = null;
                TranslationCredentialStore.prototype.lookup = async () => 'test-key';
                OpenAITranslationProvider.prototype.checkConnection = async function (key, request) {
                    assert(key === 'test-key', 'the check must use the saved credential');
                    checkedModel = this.model;
                    checkedRequest = request;
                    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    }));
                    if (failureCode) {
                        const error = new Error('test-key must never appear in the UI');
                        error.code = failureCode;
                        throw error;
                    }
                };
                try {
                    endpointRow.text = 'http://127.0.0.1:28883/responses';
                    modelRow.text = 'unsaved-test-model';
                    connectionButton.emit('clicked');
                    assert(!connectionButton.sensitive,
                        'connection checks must disable duplicate submission');
                    for (let attempt = 0; attempt < 30 && !connectionButton.sensitive; attempt++) {
                        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        }));
                    }
                    assert(connectionButton.sensitive && checkedModel === 'unsaved-test-model' &&
                        connectionRow.subtitle === uiText(
                            'Connection successful: model and structured responses are available',
                            '连接成功：模型和结构化响应可用',
                            '連線成功：模型與結構化回應可用') &&
                        settings.get_string('translation-model') === 'gpt-5.4-mini-2026-03-17',
                    'checks must use entered values, show success and leave saved settings intact');
                    failureCode = 'authentication_error';
                    connectionButton.emit('clicked');
                    for (let attempt = 0; attempt < 30 && !connectionButton.sensitive; attempt++) {
                        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        }));
                    }
                    assert(connectionButton.sensitive && connectionRow.subtitle === uiText(
                        'Translation API key was rejected', '翻译 API 密钥被拒绝', '翻譯 API 金鑰遭拒'),
                    'failed checks must show a safe localized status and allow retry');
                    failureCode = null;
                    connectionButton.emit('clicked');
                    await Promise.resolve();
                    modelRow.text = 'changed-during-check';
                    assert(checkedRequest.is_cancelled() && connectionButton.sensitive,
                        'editing the model must cancel the active check');
                    connectionButton.emit('clicked');
                    await Promise.resolve();
                    modelRow.text = '';
                    window.close();
                    assert(window.visible && settings.get_string('translation-model') ===
                        'gpt-5.4-mini-2026-03-17',
                    'invalid pending settings must block closing without overwriting saved values');
                    modelRow.text = 'changed-during-check';
                    connectionButton.emit('clicked');
                    await Promise.resolve();
                    window.close();
                    assert(checkedRequest.is_cancelled(), 'closing preferences must cancel the check');
                    const reopened = new Adw.PreferencesWindow({application: app});
                    await preferences.fillPreferencesWindow(reopened);
                    const reopenedModel = descendants(reopened).find(widget =>
                        widget instanceof Adw.EntryRow && widget.title === uiText('Model', '模型'));
                    const reopenedEndpoint = descendants(reopened).find(widget =>
                        widget instanceof Adw.EntryRow && widget.title === uiText(
                            'Responses API endpoint', 'Responses API 端点', 'Responses API 端點'));
                    assert(reopenedModel.text === 'changed-during-check' &&
                        reopenedEndpoint.text === 'http://127.0.0.1:28883/responses',
                    'closing without Apply must persist both valid fields for a reopened window');
                    reopened.close();
                } finally {
                    TranslationCredentialStore.prototype.lookup = originalLookup;
                    OpenAITranslationProvider.prototype.checkConnection = originalCheck;
                }
                print('GTK4/Libadwaita preferences window test passed');
                app.release();
                app.quit();
            } catch (error) {
                scenarioError = error;
                logError(error);
                app.release();
                app.quit();
            }
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
            checkPreferences();
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
