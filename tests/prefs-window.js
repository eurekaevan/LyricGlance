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

function allToplevelWidgets() {
    const toplevels = Gtk.Window.get_toplevels();
    const result = [];
    for (let index = 0; index < toplevels.get_n_items(); index++) {
        const top = toplevels.get_item(index);
        result.push(top, ...descendants(top));
    }
    return result;
}

function waitMs(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitUntil(predicate, attempts = 40, intervalMs = 20) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const value = predicate();
        if (value)
            return value;
        await waitMs(intervalMs);
    }
    return predicate();
}

async function takeWidgetScreenshot(widget, path) {
    const paintable = new Gtk.WidgetPaintable({widget});
    // GTK can discard an unobserved widget's cached render node. Wait for
    // the paintable's next rendered image before taking a snapshot.
    await new Promise((resolve, reject) => {
        const signal = paintable.connect('invalidate-contents', () => {
            paintable.disconnect(signal);
            GLib.source_remove(frameTimeoutId);
            resolve();
        });
        const frameTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            paintable.disconnect(signal);
            reject(new Error('preferences screenshot did not receive a rendered frame'));
            return GLib.SOURCE_REMOVE;
        });
        widget.queue_draw();
    });
    const width = widget.get_width();
    const height = widget.get_height();
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
assert(metadata.url === 'https://github.com/eurekaevan/LyricGlance' &&
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
                'preferences should contain seven top-level boolean SwitchRows');
                assert(widgets.filter(widget => widget instanceof Adw.SpinRow)
                    .length === 2,
                'preferences should contain width and global-offset SpinRows');
                assert(widgets.filter(widget => widget instanceof Adw.ComboRow)
                    .length === 5,
                'preferences should expose position, popup, panel, active provider and active model ComboRows');
                assert(widgets.filter(widget => widget instanceof Adw.EntryRow)
                    .length === 2,
                'top-level preferences should expose LrcAPI endpoint and target language entries');

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
                lrcApiEndpoint.text = 'https://api.lrc.cx/jsonapi';
                assert(!lrcApiEndpoint.has_css_class('error'),
                    'editing LrcAPI endpoint should clear its error state');
                lrcApiEndpoint.text = 'http://127.0.0.1:28883/jsonapi';
                lrcApiEndpoint.emit('apply');
                assert(!lrcApiEndpoint.has_css_class('error') &&
                    preferences.getSettings().get_string('lrcapi-endpoint') === lrcApiEndpoint.text,
                'applying a loopback endpoint should persist it');
                lrcApiSwitch.active = false;

                const targetLanguageRow = widgets.find(widget =>
                    widget instanceof Adw.EntryRow &&
                    widget.title === uiText('Target language', '目标语言', '目標語言'));
                const panelPositionRow = widgets.find(widget =>
                    widget instanceof Adw.ComboRow &&
                    widget.title === uiText('Panel position', '顶栏位置', '頂欄位置'));
                const clearArtworkButton = widgets.find(widget =>
                    widget instanceof Gtk.Button &&
                    widget.label === uiText('Clear Artwork Cache', '清除封面缓存', '清除封面快取'));
                assert(targetLanguageRow && panelPositionRow && clearArtworkButton,
                    'preferences should expose target language, panel position and artwork cache controls');
                const settings = preferences.getSettings();
                targetLanguageRow.text = 'zh-';
                assert(settings.get_string('translation-target-language') === 'zh-CN',
                    'typing into target language must not write partial values on every keystroke');
                targetLanguageRow.emit('apply');
                assert(targetLanguageRow.has_css_class('error') &&
                    settings.get_string('translation-target-language') === 'zh-CN',
                'an invalid BCP 47 target language must be rejected on Apply');
                targetLanguageRow.text = 'ja';
                targetLanguageRow.emit('apply');
                assert(!targetLanguageRow.has_css_class('error') &&
                    settings.get_string('translation-target-language') === 'ja',
                'applying a valid target language should persist it');
                targetLanguageRow.text = 'zh-CN';
                targetLanguageRow.emit('apply');
                settings.set_string('panel-position', 'far-right');
                assert(panelPositionRow.selected === 4,
                    'ComboRow should stay synchronized with external GSettings changes');
                settings.set_string('panel-position', 'center');

                const preferredPlayerRow = widgets.find(widget =>
                    widget instanceof Adw.ActionRow &&
                    widget.title === uiText('Preferred player', '首选播放器', '偏好播放器'));
                const cacheRow = widgets.find(widget =>
                    widget instanceof Adw.ActionRow &&
                    widget.title === uiText('Lyrics cache', '歌词缓存', '歌詞快取'));
                assert(preferredPlayerRow && !preferredPlayerRow.use_markup &&
                    cacheRow && !cacheRow.use_markup,
                'dynamic ActionRows must disable Pango markup parsing');
                settings.set_string('preferred-player', 'identity:Music & <Video>');
                assert(preferredPlayerRow.subtitle === 'identity:Music & <Video>',
                    'special characters in preferred-player must render literally');
                settings.set_string('preferred-player', 'auto');

                if (screenshotPath)
                    await takeWidgetScreenshot(window, screenshotPath);

                const activeProviderRow = widgets.find(widget =>
                    widget instanceof Adw.ComboRow &&
                    widget.title === uiText('Active provider', '当前模型服务', '目前模型服務'));
                const activeModelRow = widgets.find(widget =>
                    widget instanceof Adw.ComboRow &&
                    widget.title === uiText('Active model', '当前模型', '目前模型'));
                const addProviderButton = widgets.find(widget =>
                    widget instanceof Gtk.Button &&
                    widget.label === uiText('Add provider', '添加模型服务', '新增模型服務'));
                const openAiRow = widgets.find(widget =>
                    widget instanceof Adw.ActionRow &&
                    widget.title === 'OpenAI');
                assert(activeProviderRow && activeModelRow && addProviderButton && openAiRow,
                    'translation page should expose active provider/model selectors and provider list');

                const {TranslationCredentialStore} = await import(
                    directory.get_child('credentials.js').get_uri());
                const {OpenAITranslationProvider} = await import(
                    directory.get_child('translation-provider.js').get_uri());
                const originalLookup = TranslationCredentialStore.prototype.lookup;
                const originalClear = TranslationCredentialStore.prototype.clear;
                const originalCheck = OpenAITranslationProvider.prototype.checkConnection;
                const originalFetchModels = OpenAITranslationProvider.prototype.fetchModels;

                let checkedRequest = null;
                let checkedModel = null;
                let checkedEndpoint = null;
                let checkedProtocol = null;
                let failureCode = null;
                let fetchedModelsEndpoint = null;
                let fetchedProviderId = null;
                const clearedCredentials = [];

                TranslationCredentialStore.prototype.lookup = async () => 'test-key';
                TranslationCredentialStore.prototype.clear = async providerId => {
                    clearedCredentials.push(providerId);
                    return true;
                };
                OpenAITranslationProvider.prototype.checkConnection = async function (key, request) {
                    assert(key === 'test-key', 'the check must use the saved credential');
                    checkedModel = this.model;
                    checkedEndpoint = this._endpoint;
                    checkedProtocol = this._protocol;
                    checkedRequest = request;
                    await waitMs(60);
                    if (failureCode) {
                        const error = new Error('test-key must never appear in the UI');
                        error.code = failureCode;
                        throw error;
                    }
                };
                OpenAITranslationProvider.prototype.fetchModels = async function (key, request) {
                    assert(key === 'test-key', 'fetchModels must use the saved credential');
                    assert(request && !request.is_cancelled(), 'fetchModels must pass an active cancellable');
                    fetchedModelsEndpoint = this._modelsEndpoint;
                    fetchedProviderId = this.id;
                    await waitMs(40);
                    return ['deepseek-reasoner', 'deepseek-chat', 'qwen-plus'];
                };

                try {
                    // 1. Open default OpenAI provider editor subpage and test edits + connection checks.
                    openAiRow.emit('activated');
                    await waitMs(50);
                    let editorWidgets = descendants(window);
                    const nameRow = editorWidgets.find(widget =>
                        widget instanceof Adw.EntryRow &&
                        widget.title === uiText('Name', '名称', '名稱'));
                    const endpointRow = editorWidgets.find(widget =>
                        widget instanceof Adw.EntryRow &&
                        widget.title === uiText('API address', 'API 地址', 'API 位址'));
                    const protocolRow = editorWidgets.find(widget =>
                        widget instanceof Adw.ComboRow &&
                        widget.title === uiText('API protocol', 'API 协议', 'API 協定'));
                    const backendRow = editorWidgets.find(widget =>
                        widget instanceof Adw.ActionRow &&
                        widget.title === uiText('Translation backend', '翻译后端', '翻譯後端'));
                    const addModelRow = editorWidgets.find(widget =>
                        widget instanceof Adw.EntryRow &&
                        widget.title === uiText('Add model', '添加模型', '新增模型'));
                    const saveButton = editorWidgets.find(widget =>
                        widget instanceof Gtk.Button &&
                        widget.label === uiText('Save', '保存', '儲存'));
                    const connectionButton = editorWidgets.find(widget =>
                        widget instanceof Gtk.Button &&
                        widget.label === uiText('Check connection', '检查连通性', '檢查連線'));
                    const connectionRow = editorWidgets.find(widget =>
                        widget instanceof Adw.ActionRow &&
                        widget.title === uiText('Translation connection', '翻译连通性', '翻譯連線'));
                    const fetchModelsRow = editorWidgets.find(widget =>
                        widget instanceof Adw.ActionRow &&
                        widget.title === uiText('Model list', '模型列表', '模型清單'));
                    assert(nameRow && endpointRow && protocolRow && backendRow && addModelRow &&
                        saveButton && connectionButton && connectionRow && fetchModelsRow,
                    'provider detail subpage should expose all service, model and connection controls');
                    assert(fetchModelsRow.subtitle === 'GET https://api.openai.com/v1/models',
                        `models preview should resolve GET /models (got ${fetchModelsRow.subtitle})`);

                    endpointRow.text = 'http://unsafe.example/v1/responses';
                    connectionButton.emit('clicked');
                    assert(connectionButton.sensitive && connectionRow.subtitle === uiText(
                        'Use HTTPS, or HTTP only for a local loopback endpoint',
                        '请使用 HTTPS；只有本机回环端点可以使用 HTTP',
                        '請使用 HTTPS；只有本機回送端點可以使用 HTTP'),
                    'invalid check endpoints must be rejected before looking up credentials');

                    endpointRow.text = 'http://127.0.0.1:28883/proxy/v1/';
                    protocolRow.selected = 2;
                    assert(backendRow.subtitle.includes('http://127.0.0.1:28883/proxy/v1/chat/completions') &&
                        fetchModelsRow.subtitle === 'GET http://127.0.0.1:28883/proxy/v1/models',
                    'backend and models previews must track entered endpoint and protocol');

                    connectionButton.emit('clicked');
                    assert(!connectionButton.sensitive,
                        'connection checks must disable duplicate submission');
                    await waitUntil(() => connectionButton.sensitive);
                    assert(connectionButton.sensitive &&
                        checkedModel === 'gpt-5.4-mini-2026-03-17' &&
                        checkedProtocol === 'chat-completions' &&
                        checkedEndpoint === 'http://127.0.0.1:28883/proxy/v1/chat/completions' &&
                        connectionRow.subtitle === uiText(
                            'Connection successful: model and structured responses are available',
                            '连接成功：模型和结构化响应可用',
                            '連線成功：模型與結構化回應可用') &&
                        settings.get_string('translation-api-protocol') === 'auto',
                    'checks must use entered values, show success and leave saved settings intact');

                    failureCode = 'authentication_error';
                    connectionButton.emit('clicked');
                    await waitUntil(() => connectionButton.sensitive);
                    assert(connectionButton.sensitive && connectionRow.subtitle === uiText(
                        'Translation API key was rejected', '翻译 API 密钥被拒绝', '翻譯 API 金鑰遭拒'),
                    'failed checks must show a safe localized status and allow retry');
                    failureCode = null;

                    connectionButton.emit('clicked');
                    await Promise.resolve();
                    protocolRow.selected = 1;
                    assert(checkedRequest.is_cancelled() && connectionButton.sensitive,
                        'changing protocol must cancel the active connection check');
                    protocolRow.selected = 2;

                    saveButton.emit('clicked');
                    assert(settings.get_string('translation-api-endpoint') ===
                            'http://127.0.0.1:28883/proxy/v1/' &&
                        settings.get_string('translation-api-protocol') === 'chat-completions',
                    'clicking Save in the provider editor must persist changes immediately');

                    settings.set_string('translation-model', 'external-synced-model');
                    assert(activeModelRow.model.get_string(activeModelRow.selected) === 'external-synced-model',
                        'external GSettings model changes should sync into the Preferences UI');
                    settings.set_string('translation-model', 'gpt-5.4-mini-2026-03-17');

                    endpointRow.text = 'https://api.openai.com/v1/responses';
                    protocolRow.selected = 0;
                    saveButton.emit('clicked');
                    window.pop_subpage();
                    await waitUntil(() => !descendants(window).includes(saveButton));

                    // 2. Add a custom provider, fetch models from GET /models, search & check in dialog, and save.
                    addProviderButton.emit('clicked');
                    const newSaveButton = await waitUntil(() =>
                        descendants(window).find(widget =>
                            widget instanceof Gtk.Button &&
                            widget.label === uiText('Save', '保存', '儲存')));
                    editorWidgets = descendants(window);
                    const newNameRow = editorWidgets.find(widget =>
                        widget instanceof Adw.EntryRow &&
                        widget.title === uiText('Name', '名称', '名稱'));
                    const newEndpointRow = editorWidgets.find(widget =>
                        widget instanceof Adw.EntryRow &&
                        widget.title === uiText('API address', 'API 地址', 'API 位址'));
                    const newProtocolRow = editorWidgets.find(widget =>
                        widget instanceof Adw.ComboRow &&
                        widget.title === uiText('API protocol', 'API 协议', 'API 協定'));
                    const newAddModelRow = editorWidgets.find(widget =>
                        widget instanceof Adw.EntryRow &&
                        widget.title === uiText('Add model', '添加模型', '新增模型'));
                    const fetchModelsButton = editorWidgets.find(widget =>
                        widget instanceof Gtk.Button &&
                        widget.label === uiText('Fetch models', '获取模型列表', '擷取模型清單'));
                    assert(newNameRow && newEndpointRow && newProtocolRow &&
                        newAddModelRow && fetchModelsButton && newSaveButton,
                    'add-provider subpage should expose all required fields');
                    assert(!newSaveButton.sensitive, 'Save should be disabled while name/endpoint are empty');

                    newNameRow.text = 'DeepSeek';
                    newProtocolRow.selected = 2;
                    newEndpointRow.text = 'http://127.0.0.1:28883/proxy/v1/';
                    assert(newSaveButton.sensitive, 'Save should enable once name, endpoint and protocol are valid');

                    // Add one manual custom model first to verify Fetch Models preserves unlisted manual models.
                    newAddModelRow.text = 'manual-custom-model';
                    newAddModelRow.emit('apply');

                    fetchModelsButton.emit('clicked');
                    const searchPlaceholder = uiText('Search models…', '搜索模型…', '搜尋模型…');
                    const searchEntry = await waitUntil(() =>
                        allToplevelWidgets().find(widget =>
                            widget instanceof Gtk.SearchEntry &&
                            widget.placeholder_text === searchPlaceholder));
                    assert(searchEntry &&
                        fetchedModelsEndpoint === 'http://127.0.0.1:28883/proxy/v1/models' &&
                        fetchedProviderId?.startsWith('provider-'),
                    `Fetch models should query the resolved /models endpoint and open the searchable model picker (searchEntry=${Boolean(searchEntry)}, endpoint=${fetchedModelsEndpoint}, providerId=${fetchedProviderId})`);

                    const pickerDialog = searchEntry.get_ancestor(Adw.Dialog) ??
                        searchEntry.get_root() ?? window;
                    searchEntry.text = 'deepseek';
                    const modelChecks = await waitUntil(() => {
                        const checks = descendants(pickerDialog).filter(widget =>
                            widget instanceof Gtk.CheckButton && widget._modelId);
                        return checks.length === 2 &&
                            checks.every(check => check._modelId.includes('deepseek'))
                            ? checks
                            : null;
                    });
                    assert(modelChecks,
                        'searching "deepseek" should filter ListView checkboxes to matching models');
                    for (const check of modelChecks)
                        check.active = true;

                    const applyModelsButton = descendants(pickerDialog).find(widget =>
                        widget instanceof Gtk.Button &&
                        widget.label === uiText('Apply', '应用', '套用'));
                    assert(applyModelsButton, 'model picker dialog should expose an Apply button');
                    applyModelsButton.emit('clicked');
                    await waitUntil(() => !allToplevelWidgets().includes(searchEntry));

                    newSaveButton.emit('clicked');
                    await waitUntil(() => !descendants(window).includes(newSaveButton));

                    const storedProviders = JSON.parse(settings.get_string('translation-providers'));
                    assert(storedProviders.length === 2,
                        `saving custom provider should persist 2 providers (got ${storedProviders.length})`);
                    const deepseek = storedProviders.find(provider => provider.name === 'DeepSeek');
                    assert(deepseek &&
                        deepseek.endpoint === 'http://127.0.0.1:28883/proxy/v1/' &&
                        deepseek.protocol === 'chat-completions' &&
                        deepseek.models.includes('manual-custom-model') &&
                        deepseek.models.includes('deepseek-chat') &&
                        deepseek.models.includes('deepseek-reasoner') &&
                        !deepseek.models.includes('qwen-plus'),
                    'saved custom provider must retain manual models and checked fetched models');

                    // 3. Switch active provider & active model from top-level ComboRows.
                    const deepseekIndex = storedProviders.findIndex(provider => provider.id === deepseek.id);
                    activeProviderRow.selected = deepseekIndex;
                    assert(settings.get_string('translation-provider') === deepseek.id &&
                        settings.get_string('translation-api-endpoint') === deepseek.endpoint &&
                        settings.get_string('translation-api-protocol') === 'chat-completions',
                    'selecting a custom provider should update active runtime GSettings atomically');

                    const targetModelIndex = deepseek.models.indexOf('deepseek-chat');
                    activeModelRow.selected = targetModelIndex;
                    assert(settings.get_string('translation-model') === 'deepseek-chat',
                        'selecting an active model should persist it to GSettings');

                    // 4. Delete the custom provider and verify Secret Service cleanup + fallback to OpenAI.
                    const originalChoose = Adw.AlertDialog.prototype.choose;
                    const originalChooseFinish = Adw.AlertDialog.prototype.choose_finish;
                    Adw.AlertDialog.prototype.choose = function (_parent, _cancellable, callback) {
                        callback(this, {});
                    };
                    Adw.AlertDialog.prototype.choose_finish = () => 'delete';
                    try {
                        const deepseekRow = descendants(window).find(widget =>
                            widget instanceof Adw.ActionRow && widget.title === 'DeepSeek');
                        assert(deepseekRow, 'custom provider should appear in the providers list');
                        deepseekRow.emit('activated');
                        await waitMs(50);
                        const deleteRow = descendants(window).find(widget =>
                            widget instanceof Adw.ButtonRow &&
                            widget.title === uiText('Delete provider', '删除模型服务', '刪除模型服務'));
                        assert(deleteRow, 'existing provider editor should expose Delete provider when >1 providers exist');
                        deleteRow.emit('activated');
                        await waitUntil(() => !descendants(window).includes(deleteRow));
                    } finally {
                        Adw.AlertDialog.prototype.choose = originalChoose;
                        Adw.AlertDialog.prototype.choose_finish = originalChooseFinish;
                    }
                    const afterDelete = JSON.parse(settings.get_string('translation-providers'));
                    assert(afterDelete.length === 1 &&
                        afterDelete[0].id === 'openai' &&
                        settings.get_string('translation-provider') === 'openai' &&
                        clearedCredentials.includes(deepseek.id),
                    'deleting the active custom provider should clear its credential and fall back to OpenAI');

                    // 5. Verify invalid drafts are discarded on close without overwriting saved values.
                    const openAiRowAgain = descendants(window).find(widget =>
                        widget instanceof Adw.ActionRow && widget.title === 'OpenAI');
                    openAiRowAgain.emit('activated');
                    await waitMs(50);
                    const draftEndpoint = descendants(window).find(widget =>
                        widget instanceof Adw.EntryRow &&
                        widget.title === uiText('API address', 'API 地址', 'API 位址'));
                    draftEndpoint.text = 'http://unsafe.example/v1/responses';
                    window.close();
                    assert(!window.visible &&
                        settings.get_string('translation-api-endpoint') ===
                            'https://api.openai.com/v1/responses',
                    'invalid drafts must allow closing without overwriting saved provider settings');

                    // 6. Verify closing during a pending credential lookup does not open a dialog.
                    const closingWindow = new Adw.PreferencesWindow({application: app});
                    await preferences.fillPreferencesWindow(closingWindow);
                    closingWindow.present();
                    const closingOpenAiRow = descendants(closingWindow).find(widget =>
                        widget instanceof Adw.ActionRow && widget.title === 'OpenAI');
                    closingOpenAiRow.emit('activated');
                    await waitMs(50);
                    const configureButton = descendants(closingWindow).find(widget =>
                        widget instanceof Gtk.Button &&
                        widget.label === uiText('Configure', '配置', '設定'));
                    assert(configureButton, 'provider editor should expose credential configuration');
                    let finishLookup = null;
                    let dialogCount = 0;
                    TranslationCredentialStore.prototype.lookup = () => new Promise(resolve => {
                        finishLookup = resolve;
                    });
                    const restoreChoose = Adw.AlertDialog.prototype.choose;
                    Adw.AlertDialog.prototype.choose = () => {
                        dialogCount++;
                    };
                    try {
                        configureButton.emit('clicked');
                        assert(finishLookup, 'Configure should wait for credential status');
                        closingWindow.close();
                        finishLookup(null);
                        await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        }));
                        assert(!closingWindow.visible && dialogCount === 0,
                            'a credential lookup completing after closing must not open a dialog');
                    } finally {
                        finishLookup?.(null);
                        Adw.AlertDialog.prototype.choose = restoreChoose;
                        closingWindow.close();
                    }
                } finally {
                    TranslationCredentialStore.prototype.lookup = originalLookup;
                    TranslationCredentialStore.prototype.clear = originalClear;
                    OpenAITranslationProvider.prototype.checkConnection = originalCheck;
                    OpenAITranslationProvider.prototype.fetchModels = originalFetchModels;
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
Gio.Settings.sync();
Gio.resources_unregister(extensionsResource);
if (scenarioError)
    throw scenarioError;
if (status !== 0)
    throw new Error(`preferences application exited with status ${status}`);
