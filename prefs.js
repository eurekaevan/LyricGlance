import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {clearArtworkCache, countArtworkCache} from './artwork-loader.js';
import {isValidCredential, TranslationCredentialStore} from './credentials.js';
import {clearLyricsCache, countLyricsCache} from './storage.js';
import {normalizeLrcApiEndpoint} from './lyrics.js';
import {
    clearTranslationCache,
    countTranslationCache,
} from './translation-cache.js';
import {
    createTranslationProviderId,
    loadTranslationProviders,
    normalizeTranslationEndpoint,
    OpenAITranslationProvider,
    resolveModelsEndpoint,
    resolveTranslationEndpoint,
    saveTranslationProviders,
    TRANSLATION_API_PROTOCOLS,
} from './translation-provider.js';
import {translationNetworkErrorText} from './ui-utils.js';

function bindSwitch(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function bumpGeneration(settings, key) {
    const generation = settings.get_int(key);
    settings.set_int(key, generation === 2_147_483_647
        ? 0
        : generation + 1);
}

function normalizeTargetLanguage(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim().replaceAll('_', '-');
    if (!trimmed || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(trimmed))
        return null;
    try {
        return Intl.getCanonicalLocales(trimmed)[0] ?? null;
    } catch {
        return null;
    }
}

function comboRow(settings, key, title, choices, signalIds) {
    const values = choices.map(choice => choice.value);
    const selected = Math.max(0, values.indexOf(settings.get_string(key)));
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(choice => choice.label)),
        selected,
    });
    row.connect('notify::selected', () => {
        const value = values[row.selected] ?? values[0];
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    signalIds.push(settings.connect(`changed::${key}`, () => {
        const index = values.indexOf(settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    }));
    return row;
}

function protocolDisplayName(protocol) {
    return protocol === 'chat-completions' ? 'Chat Completions' : 'Responses';
}

function stringListEquals(model, values) {
    if (!model || model.get_n_items() !== values.length)
        return false;
    for (let index = 0; index < values.length; index++) {
        if (model.get_string(index) !== values[index])
            return false;
    }
    return true;
}

function providerErrorText(error, fallbackMessage, _) {
    const messages = {
        authentication_error: _('Translation API key was rejected'),
        permission_denied: _('Translation access was denied'),
        quota_exceeded: _('Translation quota or spending limit reached'),
        rate_limited: _('Translation rate limited'),
        network_error: translationNetworkErrorText(error.networkReason, _),
        invalid_response: fallbackMessage,
    };
    return messages[error.code] ?? fallbackMessage;
}

function resolveProviderFormRequest(endpointText, protocolIndex, _) {
    const endpoint = normalizeTranslationEndpoint(endpointText);
    const protocol = TRANSLATION_API_PROTOCOLS[protocolIndex] ?? 'auto';
    const resolved = endpoint && resolveTranslationEndpoint(endpoint, protocol);
    if (!endpoint) {
        return {
            endpoint: null,
            protocol,
            resolved: null,
            error: _('Use HTTPS, or HTTP only for a local loopback endpoint'),
        };
    }
    if (!resolved) {
        return {
            endpoint,
            protocol,
            resolved: null,
            error: _('The API address does not match the selected protocol'),
        };
    }
    return {endpoint, protocol, resolved, error: null};
}

async function runProviderRequest(
    credentialStore,
    {id, endpoint, protocol, model},
    request,
    action,
    fallbackForError,
    _
) {
    let provider = null;
    let credential = null;
    try {
        credential = await credentialStore.lookup(id, request);
        if (request.is_cancelled())
            return {cancelled: true};
        if (!credential)
            return {error: _('Translation API key is not configured')};
        provider = new OpenAITranslationProvider({
            id,
            endpoint,
            protocol,
            model,
            timeoutSeconds: 15,
        });
        const value = await action(provider, credential, request);
        return request.is_cancelled() ? {cancelled: true} : {value};
    } catch (error) {
        if (request.is_cancelled())
            return {cancelled: true};
        return {
            error: !provider
                ? _('Secret Service unavailable')
                : providerErrorText(error, fallbackForError(error), _),
        };
    } finally {
        credential = null;
        provider?.destroy();
    }
}

function buildPanelGroup({settings, signalIds, _}) {
    const panelGroup = new Adw.PreferencesGroup({title: _('Panel')});
    panelGroup.add(bindSwitch(
        settings, 'show-icon', _('Show music note icon')));
    const panelPositionRow = comboRow(
        settings,
        'panel-position',
        _('Panel position'),
        [
            {value: 'left', label: _('Left')},
            {value: 'right', label: _('Right')},
            {value: 'center', label: _('Center')},
            {value: 'far-left', label: _('Far left')},
            {value: 'far-right', label: _('Far right')},
        ],
        signalIds);
    panelPositionRow.subtitle =
        _('Left and Right stay near the center; Far positions use the outer edge');
    panelGroup.add(panelPositionRow);

    const widthRow = new Adw.SpinRow({
        title: _('Maximum panel width'),
        subtitle: _('Maximum width of lyrics in the top bar'),
        adjustment: new Gtk.Adjustment({
            lower: 150,
            upper: 1000,
            step_increment: 10,
            page_increment: 50,
            value: settings.get_int('max-panel-width'),
        }),
        digits: 0,
    });
    panelGroup.add(widthRow);
    widthRow.connect('notify::value', () => {
        settings.set_int('max-panel-width', Math.round(widthRow.value));
    });
    signalIds.push(settings.connect('changed::max-panel-width', () => {
        const value = settings.get_int('max-panel-width');
        if (widthRow.value !== value)
            widthRow.value = value;
    }));

    panelGroup.add(bindSwitch(
        settings,
        'hide-when-paused',
        _('Hide lyrics when paused'),
        _('Keep the popup state while hiding the panel item')));
    return panelGroup;
}

function buildLyricsGroup({window, settings, signalIds, _}) {
    const lyricsGroup = new Adw.PreferencesGroup({title: _('Lyrics')});
    lyricsGroup.add(bindSwitch(
        settings,
        'fallback-track-info',
        _('Show title when lyrics are unavailable')));
    lyricsGroup.add(bindSwitch(
        settings,
        'word-sync-enabled',
        _('Word-synced highlighting'),
        _('Highlight the current word when timing is available')));

    lyricsGroup.add(bindSwitch(
        settings, 'lrcapi-enabled', _('Use LrcAPI as a fallback'),
        _('When LRCLIB has no synchronized lyrics, send the song title, artist and album to LrcAPI')));
    const lrcApiEndpointRow = new Adw.EntryRow({
        title: _('LrcAPI endpoint'),
        text: settings.get_string('lrcapi-endpoint'),
        show_apply_button: true,
    });
    lyricsGroup.add(lrcApiEndpointRow);
    settings.bind('lrcapi-enabled', lrcApiEndpointRow, 'sensitive',
        Gio.SettingsBindFlags.GET);
    lrcApiEndpointRow.connect('notify::text', () => {
        lrcApiEndpointRow.remove_css_class('error');
    });
    lrcApiEndpointRow.connect('apply', () => {
        const endpoint = normalizeLrcApiEndpoint(lrcApiEndpointRow.text);
        if (!endpoint) {
            lrcApiEndpointRow.add_css_class('error');
            window.add_toast(new Adw.Toast({title: _(
                'Use HTTPS, or HTTP only for a local loopback endpoint')}));
            return;
        }
        lrcApiEndpointRow.remove_css_class('error');
        settings.set_string('lrcapi-endpoint', endpoint);
        lrcApiEndpointRow.text = endpoint;
    });
    signalIds.push(settings.connect('changed::lrcapi-endpoint', () => {
        lrcApiEndpointRow.text = settings.get_string('lrcapi-endpoint');
        lrcApiEndpointRow.remove_css_class('error');
    }));

    const globalOffsetRow = new Adw.SpinRow({
        title: _('Global lyrics offset'),
        subtitle: _('Added to each track-specific offset'),
        adjustment: new Gtk.Adjustment({
            lower: -10,
            upper: 10,
            step_increment: 0.5,
            page_increment: 1,
            value: settings.get_int('global-offset-ms') / 1000,
        }),
        digits: 1,
    });
    lyricsGroup.add(globalOffsetRow);
    globalOffsetRow.connect('notify::value', () => {
        settings.set_int(
            'global-offset-ms', Math.round(globalOffsetRow.value * 1000));
    });
    signalIds.push(settings.connect('changed::global-offset-ms', () => {
        const value = settings.get_int('global-offset-ms') / 1000;
        if (globalOffsetRow.value !== value)
            globalOffsetRow.value = value;
    }));
    return lyricsGroup;
}

function buildPlayerGroup({settings, signalIds, _}) {
    const playerGroup = new Adw.PreferencesGroup({
        title: _('Player'),
        description: _('Choose among currently available players from the extension popup.'),
    });
    const preferredPlayerRow = new Adw.ActionRow({
        title: _('Preferred player'),
        subtitle: settings.get_string('preferred-player') === 'auto'
            ? _('Auto')
            : settings.get_string('preferred-player'),
        use_markup: false,
    });
    playerGroup.add(preferredPlayerRow);
    signalIds.push(settings.connect('changed::preferred-player', () => {
        const preferred = settings.get_string('preferred-player');
        preferredPlayerRow.subtitle = preferred === 'auto'
            ? _('Auto')
            : preferred;
    }));
    return playerGroup;
}

function buildStorageGroup({settings, cancellable, _, ngettext}) {
    const storageGroup = new Adw.PreferencesGroup({
        title: _('Storage'),
        description: _('Cached lyrics are stored locally and expire automatically.'),
    });

    const cacheRow = new Adw.ActionRow({
        title: _('Lyrics cache'),
        subtitle: _('Positive results: 30 days; unavailable lyrics: 24 hours'),
        use_markup: false,
    });
    const clearButton = new Gtk.Button({
        label: _('Clear Lyrics Cache'),
        valign: Gtk.Align.CENTER,
    });
    clearButton.add_css_class('destructive-action');
    cacheRow.add_suffix(clearButton);
    storageGroup.add(cacheRow);
    const updateLyricsCacheCount = async () => {
        try {
            const count = await countLyricsCache(undefined, cancellable);
            if (!cancellable.is_cancelled()) {
                cacheRow.subtitle = ngettext(
                    '%d cached lyrics result (including missing lyrics)',
                    '%d cached lyrics results (including missing lyrics)', count).format(count);
            }
        } catch {
            if (!cancellable.is_cancelled())
                cacheRow.subtitle = _('Could not inspect cache');
        }
    };
    updateLyricsCacheCount();
    clearButton.connect('clicked', async () => {
        clearButton.sensitive = false;
        try {
            await clearLyricsCache(undefined, cancellable);
            if (cancellable.is_cancelled())
                return;
            bumpGeneration(settings, 'cache-clear-generation');
            await updateLyricsCacheCount();
        } catch (error) {
            if (!cancellable.is_cancelled()) {
                cacheRow.subtitle = _('Could not clear cache: %s')
                    .format(error.message);
            }
        } finally {
            if (!cancellable.is_cancelled())
                clearButton.sensitive = true;
        }
    });

    const translationCacheRow = new Adw.ActionRow({
        title: _('Translation cache'),
        subtitle: _('Checking cached translations…'),
        use_markup: false,
    });
    const clearTranslationButton = new Gtk.Button({
        label: _('Clear Translation Cache'),
        valign: Gtk.Align.CENTER,
    });
    clearTranslationButton.add_css_class('destructive-action');
    translationCacheRow.add_suffix(clearTranslationButton);
    storageGroup.add(translationCacheRow);
    const updateTranslationCacheCount = async () => {
        try {
            const count = await countTranslationCache(undefined, cancellable);
            if (cancellable.is_cancelled())
                return;
            translationCacheRow.subtitle = ngettext(
                '%d cached song', '%d cached songs', count).format(count);
        } catch {
            if (!cancellable.is_cancelled())
                translationCacheRow.subtitle = _('Could not inspect cache');
        }
    };
    updateTranslationCacheCount();
    clearTranslationButton.connect('clicked', async () => {
        clearTranslationButton.sensitive = false;
        try {
            await clearTranslationCache(undefined, cancellable);
            if (cancellable.is_cancelled())
                return;
            bumpGeneration(
                settings, 'translation-cache-clear-generation');
            translationCacheRow.subtitle = _('Translation cache cleared');
        } catch {
            if (!cancellable.is_cancelled()) {
                translationCacheRow.subtitle = _(
                    'Could not clear translation cache');
            }
        } finally {
            if (!cancellable.is_cancelled())
                clearTranslationButton.sensitive = true;
        }
    });

    const artworkCacheRow = new Adw.ActionRow({
        title: _('Artwork cache'),
        subtitle: _('Checking cached artwork…'),
        use_markup: false,
    });
    const clearArtworkButton = new Gtk.Button({
        label: _('Clear Artwork Cache'),
        valign: Gtk.Align.CENTER,
    });
    clearArtworkButton.add_css_class('destructive-action');
    artworkCacheRow.add_suffix(clearArtworkButton);
    storageGroup.add(artworkCacheRow);
    const updateArtworkCacheCount = async () => {
        try {
            const count = await countArtworkCache(undefined, cancellable);
            if (!cancellable.is_cancelled()) {
                artworkCacheRow.subtitle = ngettext(
                    '%d cached image', '%d cached images', count).format(count);
            }
        } catch {
            if (!cancellable.is_cancelled())
                artworkCacheRow.subtitle = _('Could not inspect cache');
        }
    };
    updateArtworkCacheCount();
    clearArtworkButton.connect('clicked', async () => {
        clearArtworkButton.sensitive = false;
        try {
            await clearArtworkCache(undefined, cancellable);
            if (cancellable.is_cancelled())
                return;
            await updateArtworkCacheCount();
        } catch {
            if (!cancellable.is_cancelled())
                artworkCacheRow.subtitle = _('Could not clear artwork cache');
        } finally {
            if (!cancellable.is_cancelled())
                clearArtworkButton.sensitive = true;
        }
    });

    return storageGroup;
}

function buildGeneralPage(context) {
    const {_} = context;
    const generalPage = new Adw.PreferencesPage({
        title: _('General'),
        icon_name: 'preferences-system-symbolic',
    });
    generalPage.add(buildPanelGroup(context));
    generalPage.add(buildLyricsGroup(context));
    generalPage.add(buildPlayerGroup(context));
    generalPage.add(buildStorageGroup(context));
    return generalPage;
}

function buildTranslationSettingsGroup({window, settings, signalIds, _}) {
    const translationGroup = new Adw.PreferencesGroup({
        title: _('Translation'),
        description: _('Supports Responses and Chat Completions. Translations never change original timing.'),
    });
    translationGroup.add(bindSwitch(
        settings,
        'translation-enabled',
        _('Enable translation'),
        _('Original lyrics remain available if translation fails')));
    translationGroup.add(bindSwitch(
        settings,
        'auto-translate',
        _('Translate automatically'),
        _('Use a cached translation first; otherwise contact the provider')));

    const targetLanguageRow = new Adw.EntryRow({
        title: _('Target language'),
        text: settings.get_string('translation-target-language'),
        show_apply_button: true,
    });
    targetLanguageRow.add_suffix(new Gtk.Label({
        label: _('e.g. zh-CN, en, ja'),
        css_classes: ['dim-label'],
    }));
    translationGroup.add(targetLanguageRow);
    let targetLanguageDirty = false;
    targetLanguageRow.connect('notify::text', () => {
        targetLanguageDirty = true;
        targetLanguageRow.remove_css_class('error');
    });
    const saveTargetLanguage = ({notifyInvalid = false} = {}) => {
        if (!targetLanguageDirty)
            return true;
        const language = normalizeTargetLanguage(targetLanguageRow.text);
        if (!language) {
            if (notifyInvalid) {
                targetLanguageRow.add_css_class('error');
                window.add_toast(new Adw.Toast({title: _(
                    'Enter a valid BCP 47 language code, such as zh-CN, en, or ja')}));
            }
            return false;
        }
        targetLanguageRow.remove_css_class('error');
        if (settings.get_string('translation-target-language') !== language)
            settings.set_string('translation-target-language', language);
        targetLanguageRow.text = language;
        targetLanguageDirty = false;
        return true;
    };
    targetLanguageRow.connect('apply', () => {
        saveTargetLanguage({notifyInvalid: true});
    });
    signalIds.push(settings.connect('changed::translation-target-language', () => {
        const value = settings.get_string('translation-target-language');
        if (targetLanguageRow.text !== value)
            targetLanguageRow.text = value;
        targetLanguageRow.remove_css_class('error');
        targetLanguageDirty = false;
    }));

    translationGroup.add(comboRow(
        settings,
        'translation-display-mode',
        _('Popup display'),
        [
            {value: 'bilingual', label: _('Original + Translation')},
            {value: 'original', label: _('Original only')},
            {value: 'translated', label: _('Translation only')},
        ],
        signalIds));
    translationGroup.add(comboRow(
        settings,
        'panel-lyrics-language',
        _('Panel lyrics'),
        [
            {value: 'original', label: _('Original')},
            {value: 'translated', label: _('Translation')},
        ],
        signalIds));

    const activeProviderRow = new Adw.ComboRow({
        title: _('Active provider'),
        use_markup: false,
    });
    const activeModelRow = new Adw.ComboRow({
        title: _('Active model'),
        use_markup: false,
    });
    translationGroup.add(activeProviderRow);
    translationGroup.add(activeModelRow);

    return {
        group: translationGroup,
        activeProviderRow,
        activeModelRow,
        saveTargetLanguage,
    };
}

function openModelPickerDialog(
    {window, _, ngettext},
    fetchedModels,
    currentModels,
    pageCancellable,
    onApply
) {
    const selected = new Set(currentModels);
    const fetchedSet = new Set(fetchedModels);
    const orderedModels = [
        ...fetchedModels.filter(id => selected.has(id)),
        ...fetchedModels.filter(id => !selected.has(id)),
    ];

    const dialog = new Adw.Dialog({
        title: _('Select models'),
        content_width: 480,
        content_height: 540,
    });
    const toolbarView = new Adw.ToolbarView();
    const headerBar = new Adw.HeaderBar({
        show_start_title_buttons: false,
        show_end_title_buttons: false,
    });
    const cancelButton = new Gtk.Button({label: _('Cancel')});
    const applyModelsButton = new Gtk.Button({label: _('Apply')});
    applyModelsButton.add_css_class('suggested-action');
    headerBar.pack_start(cancelButton);
    headerBar.pack_end(applyModelsButton);
    toolbarView.add_top_bar(headerBar);

    const searchBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_start: 12,
        margin_end: 12,
        margin_top: 6,
        margin_bottom: 6,
    });
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: _('Search models…'),
        hexpand: true,
    });
    searchBox.append(searchEntry);

    const summaryBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
    });
    const summaryLabel = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        css_classes: ['dim-label', 'caption'],
    });
    const clearSelectionButton = new Gtk.Button({
        label: _('Clear selection'),
        css_classes: ['flat'],
    });
    summaryBox.append(summaryLabel);
    summaryBox.append(clearSelectionButton);
    searchBox.append(summaryBox);
    toolbarView.add_top_bar(searchBox);

    const stringList = Gtk.StringList.new(orderedModels);
    const filter = Gtk.CustomFilter.new(item => {
        const query = searchEntry.text.trim().toLowerCase();
        return !query || item.string.toLowerCase().includes(query);
    });
    const filterModel = new Gtk.FilterListModel({
        model: stringList,
        filter,
    });
    const selectionModel = new Gtk.NoSelection({model: filterModel});

    const updateSummary = () => {
        const visibleCount = filterModel.get_n_items();
        let selectedCount = 0;
        for (const id of fetchedSet) {
            if (selected.has(id))
                selectedCount++;
        }
        const availableText = ngettext(
            '%d model', '%d models', visibleCount)
            .replace('%d', String(visibleCount));
        const selectedText = ngettext(
            '%d selected', '%d selected', selectedCount)
            .replace('%d', String(selectedCount));
        summaryLabel.label = `${availableText} · ${selectedText}`;
        clearSelectionButton.sensitive = selectedCount > 0;
    };

    const boundChecks = new Set();
    const factory = new Gtk.SignalListItemFactory();
    const factorySignalIds = [
        factory.connect('setup', (_factory, listItem) => {
            const label = new Gtk.Label({
                xalign: 0,
                hexpand: true,
                ellipsize: Pango.EllipsizeMode.END,
            });
            const check = new Gtk.CheckButton({
                hexpand: true,
                margin_start: 12,
                margin_end: 12,
                margin_top: 6,
                margin_bottom: 6,
            });
            check.set_child(label);
            check._label = label;
            check._syncing = false;
            check._modelId = null;
            check.connect('toggled', () => {
                if (check._syncing || !check._modelId)
                    return;
                if (check.active)
                    selected.add(check._modelId);
                else
                    selected.delete(check._modelId);
                updateSummary();
            });
            listItem.set_child(check);
        }),
        factory.connect('bind', (_factory, listItem) => {
            const check = listItem.get_child();
            const modelId = listItem.get_item().string;
            check._syncing = true;
            check._modelId = modelId;
            check._label.label = modelId;
            check.active = selected.has(modelId);
            check._syncing = false;
            boundChecks.add(check);
        }),
        factory.connect('unbind', (_factory, listItem) => {
            const check = listItem.get_child();
            boundChecks.delete(check);
            check._modelId = null;
        }),
    ];

    const listView = new Gtk.ListView({
        model: selectionModel,
        factory,
        vexpand: true,
        hexpand: true,
    });
    const scrolled = new Gtk.ScrolledWindow({
        vexpand: true,
        hexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        child: listView,
    });
    toolbarView.set_content(scrolled);
    dialog.set_child(toolbarView);
    updateSummary();

    searchEntry.connect('search-changed', () => {
        filter.changed(Gtk.FilterChange.DIFFERENT);
        updateSummary();
    });
    clearSelectionButton.connect('clicked', () => {
        for (const id of fetchedSet)
            selected.delete(id);
        for (const check of boundChecks) {
            check._syncing = true;
            check.active = false;
            check._syncing = false;
        }
        updateSummary();
    });

    let dialogClosed = false;
    let cancellingDialog = false;
    const cancelSignalId = pageCancellable.connect(() => {
        if (dialogClosed)
            return;
        cancellingDialog = true;
        try {
            dialog.force_close();
        } finally {
            cancellingDialog = false;
        }
    });
    dialog.connect('closed', () => {
        if (dialogClosed)
            return;
        dialogClosed = true;
        for (const id of factorySignalIds)
            factory.disconnect(id);
        factorySignalIds.length = 0;
        listView.model = null;
        listView.factory = null;
        boundChecks.clear();
        if (cancelSignalId && !cancellingDialog)
            pageCancellable.disconnect(cancelSignalId);
    });
    cancelButton.connect('clicked', () => dialog.close());
    applyModelsButton.connect('clicked', () => {
        const preservedCustom = currentModels.filter(
            id => !fetchedSet.has(id));
        const chosenFetched = fetchedModels.filter(
            id => selected.has(id));
        onApply([...preservedCustom, ...chosenFetched]);
        dialog.close();
    });

    dialog.present(window);
}

function createProviderEditorLayout({
    isNew,
    existing,
    draftActivate,
    fetchModelsHint,
    connectionHint,
    onCancelNew,
    _,
}) {
    const navPage = new Adw.NavigationPage({
        title: isNew ? _('Add provider') : existing.name,
    });
    const toolbarView = new Adw.ToolbarView();
    const headerBar = new Adw.HeaderBar({
        show_back_button: !isNew,
    });
    if (isNew) {
        const cancelNewButton = new Gtk.Button({label: _('Cancel')});
        cancelNewButton.connect('clicked', onCancelNew);
        headerBar.pack_start(cancelNewButton);
    }
    const saveButton = new Gtk.Button({
        label: _('Save'),
        sensitive: isNew,
    });
    saveButton.add_css_class('suggested-action');
    headerBar.pack_end(saveButton);
    toolbarView.add_top_bar(headerBar);

    const editorPage = new Adw.PreferencesPage();
    toolbarView.set_content(editorPage);
    navPage.set_child(toolbarView);

    const serviceGroup = new Adw.PreferencesGroup({
        title: _('Service'),
    });
    editorPage.add(serviceGroup);

    const nameRow = new Adw.EntryRow({
        title: _('Name'),
        text: isNew ? '' : existing.name,
    });
    serviceGroup.add(nameRow);

    const protocolRow = new Adw.ComboRow({
        title: _('API protocol'),
        model: Gtk.StringList.new([
            _('Automatic from address'),
            'Responses',
            'Chat Completions',
        ]),
        selected: Math.max(
            0,
            TRANSLATION_API_PROTOCOLS.indexOf(
                isNew ? 'auto' : existing.protocol)),
    });
    serviceGroup.add(protocolRow);

    const endpointRow = new Adw.EntryRow({
        title: _('API address'),
        text: isNew ? '' : existing.endpoint,
    });
    serviceGroup.add(endpointRow);

    const backendRow = new Adw.ActionRow({
        title: _('Translation backend'),
        use_markup: false,
    });
    serviceGroup.add(backendRow);

    const credentialRow = new Adw.ActionRow({
        title: _('Translation API key'),
        subtitle: _('Checking Secret Service…'),
        use_markup: false,
    });
    const configureCredentialButton = new Gtk.Button({
        label: _('Configure'),
        valign: Gtk.Align.CENTER,
    });
    credentialRow.add_suffix(configureCredentialButton);
    serviceGroup.add(credentialRow);

    const useProviderRow = new Adw.SwitchRow({
        title: _('Use for translation'),
        subtitle: draftActivate
            ? _('Currently active translation provider')
            : _('Switch active translation to this provider'),
        active: draftActivate,
        sensitive: !draftActivate,
    });
    serviceGroup.add(useProviderRow);

    const modelsGroup = new Adw.PreferencesGroup({
        title: _('Models'),
        description: _('Fetch available models from the service or add model names manually.'),
    });
    editorPage.add(modelsGroup);

    const fetchModelsRow = new Adw.ActionRow({
        title: _('Model list'),
        subtitle: fetchModelsHint,
        use_markup: false,
    });
    const fetchModelsButton = new Gtk.Button({
        label: _('Fetch models'),
        valign: Gtk.Align.CENTER,
    });
    fetchModelsRow.add_suffix(fetchModelsButton);
    modelsGroup.add(fetchModelsRow);

    const addModelRow = new Adw.EntryRow({
        title: _('Add model'),
        show_apply_button: true,
    });
    modelsGroup.add(addModelRow);

    const connectionGroup = new Adw.PreferencesGroup({
        title: _('Connection'),
    });
    editorPage.add(connectionGroup);
    const connectionRow = new Adw.ActionRow({
        title: _('Translation connection'),
        subtitle: connectionHint,
        use_markup: false,
    });
    const connectionButton = new Gtk.Button({
        label: _('Check connection'),
        valign: Gtk.Align.CENTER,
    });
    connectionRow.add_suffix(connectionButton);
    connectionGroup.add(connectionRow);

    return {
        navPage,
        editorPage,
        saveButton,
        nameRow,
        protocolRow,
        endpointRow,
        backendRow,
        credentialRow,
        configureCredentialButton,
        useProviderRow,
        modelsGroup,
        fetchModelsRow,
        fetchModelsButton,
        addModelRow,
        connectionRow,
        connectionButton,
    };
}

function rebuildProviderModelRows(
    modelsGroup,
    modelRows,
    draftModels,
    draftModel,
    {onSelect, onRemove, _}
) {
    for (const row of modelRows)
        modelsGroup.remove(row);
    modelRows.length = 0;

    if (draftModels.length === 0) {
        const emptyRow = new Adw.ActionRow({
            title: _('No models added yet'),
            subtitle: _('Fetch models from the service or enter a model name above'),
            sensitive: false,
            use_markup: false,
        });
        modelsGroup.add(emptyRow);
        modelRows.push(emptyRow);
        return;
    }

    let radioGroup = null;
    for (const modelId of draftModels) {
        const row = new Adw.ActionRow({
            title: modelId,
            activatable: true,
            use_markup: false,
        });
        const radio = new Gtk.CheckButton({
            active: modelId === draftModel,
            valign: Gtk.Align.CENTER,
        });
        if (radioGroup)
            radio.set_group(radioGroup);
        else
            radioGroup = radio;

        radio.connect('toggled', () => {
            if (radio.active)
                onSelect(modelId);
        });
        row.connect('activated', () => {
            radio.active = true;
        });
        row.add_prefix(radio);

        const removeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Remove model'),
        });
        removeButton.connect('clicked', () => onRemove(modelId));
        row.add_suffix(removeButton);
        modelsGroup.add(row);
        modelRows.push(row);
    }
}

function createProviderDangerGroup(
    {window, credentialStore, settings, cancellable, _},
    providerStore,
    draftId,
    pageCancellable,
    onDeleting
) {
    const dangerGroup = new Adw.PreferencesGroup();
    const deleteRow = new Adw.ButtonRow({
        title: _('Delete provider'),
        css_classes: ['destructive-action'],
    });
    dangerGroup.add(deleteRow);

    deleteRow.connect('activated', () => {
        if (pageCancellable.is_cancelled())
            return;
        const confirm = new Adw.AlertDialog({
            heading: _('Delete provider?'),
            body: _(
                'The saved configuration and its API key in Secret Service will be removed.'),
            close_response: 'cancel',
            default_response: 'cancel',
        });
        confirm.add_response('cancel', _('Cancel'));
        confirm.add_response('delete', _('Delete'));
        confirm.set_response_appearance(
            'delete', Adw.ResponseAppearance.DESTRUCTIVE);
        confirm.choose(window, pageCancellable, async (_dialog, result) => {
            try {
                const response = confirm.choose_finish(result);
                if (response !== 'delete' || pageCancellable.is_cancelled())
                    return;
                onDeleting();
                await credentialStore.clear(draftId, pageCancellable)
                    .catch(() => {});
                if (cancellable.is_cancelled())
                    return;
                const {providers, activeId} = providerStore.state;
                const wasActive = activeId === draftId;
                const remaining = providers.filter(
                    provider => provider.id !== draftId);
                const nextActive = wasActive ? remaining[0]?.id : activeId;
                providerStore.persist(remaining, nextActive);
                if (wasActive) {
                    bumpGeneration(
                        settings, 'translation-credential-generation');
                }
                providerStore.refreshUi();
                window.pop_subpage();
            } catch {
                // Dialog cancelled on close.
            }
        });
    });
    return dangerGroup;
}

async function openCredentialDialog(
    {window, credentialStore, settings, _},
    providerStore,
    {
        draftId,
        pageCancellable,
        credentialRow,
        configureButton,
        refreshCredentialStatus,
        onNewDraftKeyStored,
    }
) {
    configureButton.sensitive = false;
    try {
        const configured = await refreshCredentialStatus();
        if (pageCancellable.is_cancelled())
            return;
        const entry = new Adw.PasswordEntryRow({
            title: _('API key'),
            text: '',
        });
        const dialog = new Adw.AlertDialog({
            heading: _('Translation credential'),
            body: configured
                ? _('The saved key is not displayed. Enter a new key to replace it, or leave blank to keep it.')
                : _('The key will be stored in Secret Service and sent only to the configured endpoint.'),
            extra_child: entry,
            close_response: 'cancel',
            default_response: 'save',
        });
        dialog.add_response('cancel', _('Cancel'));
        if (configured) {
            dialog.add_response('remove', _('Remove'));
            dialog.set_response_appearance(
                'remove', Adw.ResponseAppearance.DESTRUCTIVE);
        }
        dialog.add_response('save', _('Save'));
        dialog.set_response_appearance(
            'save', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(window, pageCancellable, async (_dialog, result) => {
            try {
                const response = dialog.choose_finish(result);
                if (response === 'save' && !entry.text.trim()) {
                    if (!configured)
                        credentialRow.subtitle = _('API key cannot be empty');
                    return;
                }
                if (response === 'save' && !isValidCredential(entry.text)) {
                    credentialRow.subtitle = _('API key contains invalid characters');
                    return;
                }
                if (response === 'save') {
                    await credentialStore.store(
                        draftId, entry.text, pageCancellable);
                    onNewDraftKeyStored(true);
                } else if (response === 'remove') {
                    await credentialStore.clear(
                        draftId, pageCancellable);
                    onNewDraftKeyStored(false);
                } else {
                    return;
                }
                if (draftId === providerStore.state.activeId) {
                    bumpGeneration(
                        settings, 'translation-credential-generation');
                }
                await refreshCredentialStatus();
                providerStore.refreshUi();
            } catch {
                if (!pageCancellable.is_cancelled()) {
                    credentialRow.subtitle = _(
                        'Could not update credential in Secret Service');
                }
            } finally {
                entry.text = '';
                if (!pageCancellable.is_cancelled())
                    configureButton.sensitive = true;
            }
        });
    } catch {
        if (!pageCancellable.is_cancelled()) {
            credentialRow.subtitle = _(
                'Could not open credential configuration');
            configureButton.sensitive = true;
        }
    }
}

function openProviderEditor(context, providerStore, providerIdOrNull) {
    const {window, credentialStore, cancellable, _, ngettext} = context;
    if (providerStore.activeEditor || cancellable.is_cancelled())
        return;

    const isNew = providerIdOrNull === null;
    const existing = isNew
        ? null
        : providerStore.state.providers.find(
            provider => provider.id === providerIdOrNull);
    if (!isNew && !existing)
        return;

    const draftId = isNew
        ? createTranslationProviderId(
            providerStore.state.providers.map(provider => provider.id))
        : existing.id;
    let draftModels = isNew ? [] : [...existing.models];
    let draftModel = isNew ? '' : existing.model;
    let draftActivate = isNew
        ? false
        : existing.id === providerStore.state.activeId;
    let dirty = isNew;
    let syncingEditor = false;
    let editorClosed = false;
    let savedNewProvider = false;
    let storedKeyDuringNewDraft = false;
    let deletedProvider = false;
    let cancelledNewDraft = false;
    const modelRows = [];
    let connectionCheck = null;
    let modelFetch = null;

    const pageCancellable = new Gio.Cancellable();
    const parentCancelId = cancellable.connect(
        () => pageCancellable.cancel());

    const fetchModelsHint = _(
        'Fetch models from GET /models with the saved API key');
    const connectionHint = _(
        'Tests the entered address, protocol and selected model with the saved key. May incur a charge.');
    const ui = createProviderEditorLayout({
        isNew,
        existing,
        draftActivate,
        fetchModelsHint,
        connectionHint,
        onCancelNew: () => {
            cancelledNewDraft = true;
            window.pop_subpage();
        },
        _,
    });

    if (!isNew && providerStore.state.providers.length > 1) {
        ui.editorPage.add(createProviderDangerGroup(
            context, providerStore, draftId, pageCancellable, () => {
                deletedProvider = true;
            }));
    }

    const readDraft = () => {
        const name = ui.nameRow.text.trim();
        const {endpoint, protocol, resolved, error: requestError} =
            resolveProviderFormRequest(ui.endpointRow.text, ui.protocolRow.selected, _);
        const modelsEndpoint = resolved
            ? resolveModelsEndpoint(endpoint)
            : null;
        const error = !name
            ? _('Provider name cannot be empty')
            : requestError;
        return {
            id: draftId,
            name,
            endpoint,
            protocol,
            models: [...draftModels],
            model: draftModel,
            resolved,
            modelsEndpoint,
            error,
        };
    };

    const cancelConnectionCheck = () => {
        connectionCheck?.cancel();
        connectionCheck = null;
        if (!pageCancellable.is_cancelled()) {
            ui.connectionButton.sensitive = true;
            ui.connectionRow.subtitle = connectionHint;
        }
    };

    const cancelModelFetch = () => {
        modelFetch?.cancel();
        modelFetch = null;
        if (!pageCancellable.is_cancelled()) {
            ui.fetchModelsButton.sensitive = true;
            const {modelsEndpoint} = readDraft();
            ui.fetchModelsRow.subtitle = modelsEndpoint
                ? `GET ${modelsEndpoint}`
                : fetchModelsHint;
        }
    };

    const updateModelsEndpointPreview = () => {
        if (modelFetch || pageCancellable.is_cancelled())
            return;
        const {modelsEndpoint} = readDraft();
        ui.fetchModelsRow.subtitle = modelsEndpoint
            ? `GET ${modelsEndpoint}`
            : fetchModelsHint;
    };

    const updateBackendPreview = () => {
        const {name, resolved, error} = readDraft();
        if (!isNew && name)
            ui.navPage.title = name;
        if (resolved) {
            const label = protocolDisplayName(resolved.protocol);
            ui.backendRow.subtitle = `${label} · ${resolved.endpoint}`;
        } else {
            ui.backendRow.subtitle = error;
        }
        const hasPending = dirty || Boolean(ui.addModelRow.text.trim());
        ui.saveButton.sensitive = isNew ? !error : hasPending && !error;
    };

    const rebuildModelRows = () => {
        rebuildProviderModelRows(
            ui.modelsGroup, modelRows, draftModels, draftModel, {
                onSelect: modelId => {
                    if (draftModel === modelId)
                        return;
                    draftModel = modelId;
                    dirty = true;
                    cancelConnectionCheck();
                    if (!isNew && !readDraft().error)
                        persistEditorDraft();
                    else
                        updateBackendPreview();
                },
                onRemove: modelId => {
                    draftModels = draftModels.filter(id => id !== modelId);
                    if (draftModel === modelId)
                        draftModel = draftModels[0] ?? '';
                    dirty = true;
                    cancelConnectionCheck();
                    rebuildModelRows();
                    if (!isNew && !readDraft().error)
                        persistEditorDraft();
                    else
                        updateBackendPreview();
                },
                _,
            });
    };

    const commitPendingModelInput = () => {
        const candidate = ui.addModelRow.text.trim();
        if (!candidate)
            return false;
        if (!draftModels.includes(candidate))
            draftModels = [...draftModels, candidate];
        if (!draftModel)
            draftModel = candidate;
        syncingEditor = true;
        try {
            ui.addModelRow.text = '';
        } finally {
            syncingEditor = false;
        }
        dirty = true;
        rebuildModelRows();
        return true;
    };

    const persistEditorDraft = ({showError = false} = {}) => {
        const initialDraft = readDraft();
        if (initialDraft.error) {
            if (showError)
                ui.backendRow.subtitle = initialDraft.error;
            return false;
        }
        commitPendingModelInput();
        const draft = readDraft();
        const entry = {
            id: draft.id,
            name: draft.name,
            endpoint: draft.endpoint,
            protocol: draft.protocol,
            models: draft.models,
            model: draft.model,
        };
        const {providers, activeId} = providerStore.state;
        const existsInList = providers.some(
            provider => provider.id === draft.id);
        const nextProviders = existsInList
            ? providers.map(provider =>
                provider.id === draft.id ? entry : provider)
            : [...providers, entry];
        const nextActiveId = draftActivate ? draft.id : activeId;
        if (!providerStore.persist(nextProviders, nextActiveId))
            return false;

        syncingEditor = true;
        try {
            if (ui.nameRow.text !== entry.name)
                ui.nameRow.text = entry.name;
            if (ui.endpointRow.text !== entry.endpoint)
                ui.endpointRow.text = entry.endpoint;
        } finally {
            syncingEditor = false;
        }
        dirty = false;
        if (isNew)
            savedNewProvider = true;
        updateBackendPreview();
        providerStore.refreshUi();
        return true;
    };

    const markDirty = () => {
        if (syncingEditor)
            return;
        dirty = true;
        updateBackendPreview();
        cancelConnectionCheck();
        cancelModelFetch();
        updateModelsEndpointPreview();
    };
    ui.nameRow.connect('notify::text', () => {
        if (syncingEditor)
            return;
        dirty = true;
        updateBackendPreview();
    });
    ui.endpointRow.connect('notify::text', markDirty);
    ui.protocolRow.connect('notify::selected', markDirty);
    ui.useProviderRow.connect('notify::active', () => {
        if (syncingEditor)
            return;
        draftActivate = ui.useProviderRow.active;
        dirty = true;
        if (!isNew && draftActivate && !readDraft().error) {
            persistEditorDraft();
            ui.useProviderRow.sensitive = false;
            ui.useProviderRow.subtitle = _(
                'Currently active translation provider');
        } else {
            updateBackendPreview();
        }
    });

    ui.addModelRow.connect('notify::text', () => {
        if (!syncingEditor)
            updateBackendPreview();
    });
    ui.addModelRow.connect('apply', () => {
        if (!commitPendingModelInput())
            return;
        cancelConnectionCheck();
        if (!isNew && !readDraft().error)
            persistEditorDraft();
        else
            updateBackendPreview();
    });

    ui.saveButton.connect('clicked', () => {
        if (!persistEditorDraft({showError: true}))
            return;
        if (isNew)
            window.pop_subpage();
        else
            window.add_toast(new Adw.Toast({title: _('Provider saved')}));
    });

    const refreshCredentialStatus = async () => {
        try {
            const configured = await credentialStore.isConfigured(
                draftId, pageCancellable);
            if (pageCancellable.is_cancelled())
                return false;
            ui.credentialRow.subtitle = configured
                ? _('Saved in Secret Service; the key is not displayed')
                : _('Not configured');
            return configured;
        } catch {
            if (!pageCancellable.is_cancelled())
                ui.credentialRow.subtitle = _('Secret Service unavailable');
            return false;
        }
    };
    refreshCredentialStatus();

    ui.configureCredentialButton.connect('clicked', () => {
        openCredentialDialog(context, providerStore, {
            draftId,
            pageCancellable,
            credentialRow: ui.credentialRow,
            configureButton: ui.configureCredentialButton,
            refreshCredentialStatus,
            onNewDraftKeyStored: stored => {
                if (isNew)
                    storedKeyDuringNewDraft = stored;
            },
        });
    });

    ui.fetchModelsButton.connect('clicked', async () => {
        if (modelFetch || pageCancellable.is_cancelled())
            return;
        const {endpoint, protocol, error: requestError} =
            resolveProviderFormRequest(ui.endpointRow.text, ui.protocolRow.selected, _);
        if (requestError) {
            ui.fetchModelsRow.subtitle = requestError;
            return;
        }

        const request = new Gio.Cancellable();
        modelFetch = request;
        ui.fetchModelsButton.sensitive = false;
        ui.fetchModelsRow.subtitle = _('Fetching models…');
        let result = null;
        try {
            result = await runProviderRequest(
                credentialStore,
                {id: draftId, endpoint, protocol, model: draftModel},
                request,
                (provider, credential, cancellableRequest) =>
                    provider.fetchModels(credential, cancellableRequest),
                () => _('Could not fetch models: verify the API address and key'),
                _);
        } finally {
            if (modelFetch === request) {
                modelFetch = null;
                if (!pageCancellable.is_cancelled())
                    ui.fetchModelsButton.sensitive = true;
            }
        }
        if (request.is_cancelled() || pageCancellable.is_cancelled() ||
            !result || result.cancelled)
            return;
        if (result.error) {
            ui.fetchModelsRow.subtitle = result.error;
            return;
        }
        const fetched = result.value;
        if (!fetched)
            return;
        if (fetched.length === 0) {
            ui.fetchModelsRow.subtitle = _(
                'No models returned by this endpoint; add models manually');
            return;
        }
        ui.fetchModelsRow.subtitle = ngettext(
            'Found %d model', 'Found %d models', fetched.length)
            .replace('%d', String(fetched.length));
        openModelPickerDialog(
            context, fetched, draftModels, pageCancellable, updatedModels => {
                draftModels = updatedModels;
                if (!draftModels.includes(draftModel))
                    draftModel = draftModels[0] ?? '';
                dirty = true;
                cancelConnectionCheck();
                rebuildModelRows();
                if (!isNew && !readDraft().error)
                    persistEditorDraft();
                else
                    updateBackendPreview();
            });
    });

    ui.connectionButton.connect('clicked', async () => {
        if (connectionCheck || pageCancellable.is_cancelled())
            return;
        if (commitPendingModelInput())
            updateBackendPreview();
        const {endpoint, protocol, error: requestError} =
            resolveProviderFormRequest(ui.endpointRow.text, ui.protocolRow.selected, _);
        if (requestError) {
            ui.connectionRow.subtitle = requestError;
            return;
        }
        if (!draftModel) {
            ui.connectionRow.subtitle = _('Select or add a model first');
            return;
        }

        const request = new Gio.Cancellable();
        connectionCheck = request;
        ui.connectionButton.sensitive = false;
        ui.connectionRow.subtitle = _('Checking connection…');
        try {
            const result = await runProviderRequest(
                credentialStore,
                {id: draftId, endpoint, protocol, model: draftModel},
                request,
                (provider, credential, cancellableRequest) =>
                    provider.checkConnection(credential, cancellableRequest),
                error => error.code === 'invalid_response'
                    ? _('Connection check failed: invalid structured response')
                    : _('Connection check failed: verify the API address, protocol and model'),
                _);
            if (request.is_cancelled() || result.cancelled)
                return;
            ui.connectionRow.subtitle = result.error ?? _(
                'Connection successful: model and structured responses are available');
        } finally {
            if (connectionCheck === request) {
                connectionCheck = null;
                if (!pageCancellable.is_cancelled())
                    ui.connectionButton.sensitive = true;
            }
        }
    });

    const finalizeEditor = () => {
        if (editorClosed)
            return;
        editorClosed = true;
        if (!deletedProvider && !cancelledNewDraft) {
            if (!isNew && (dirty || ui.addModelRow.text.trim()))
                persistEditorDraft();
        }
        if (isNew && !savedNewProvider && storedKeyDuringNewDraft) {
            credentialStore.clear(draftId, null).catch(() => {});
            storedKeyDuringNewDraft = false;
        }
        connectionCheck?.cancel();
        connectionCheck = null;
        modelFetch?.cancel();
        modelFetch = null;
        pageCancellable.cancel();
        if (parentCancelId)
            cancellable.disconnect(parentCancelId);
        if (providerStore.activeEditor?.id === draftId)
            providerStore.activeEditor = null;
    };

    ui.navPage.connect('hiding', finalizeEditor);
    ui.navPage.connect('hidden', finalizeEditor);

    providerStore.activeEditor = {
        id: draftId,
        isNew,
        isDirty: () => dirty,
        onCredentialChanged: () => {
            cancelConnectionCheck();
            cancelModelFetch();
        },
        syncFromState: updatedProvider => {
            if (isNew || dirty || !updatedProvider ||
                pageCancellable.is_cancelled())
                return;
            syncingEditor = true;
            try {
                ui.nameRow.text = updatedProvider.name;
                ui.endpointRow.text = updatedProvider.endpoint;
                const protocolIndex = Math.max(
                    0,
                    TRANSLATION_API_PROTOCOLS.indexOf(
                        updatedProvider.protocol));
                if (ui.protocolRow.selected !== protocolIndex)
                    ui.protocolRow.selected = protocolIndex;
                draftModels = [...updatedProvider.models];
                draftModel = updatedProvider.model;
                draftActivate = updatedProvider.id ===
                    providerStore.state.activeId;
                ui.useProviderRow.active = draftActivate;
                ui.useProviderRow.sensitive = !draftActivate;
                ui.useProviderRow.subtitle = draftActivate
                    ? _('Currently active translation provider')
                    : _('Switch active translation to this provider');
            } finally {
                syncingEditor = false;
            }
            rebuildModelRows();
            updateBackendPreview();
            updateModelsEndpointPreview();
        },
        onWindowClose: finalizeEditor,
    };

    rebuildModelRows();
    updateBackendPreview();
    updateModelsEndpointPreview();
    window.push_subpage(ui.navPage);
}

function buildTranslationPage(context) {
    const {
        settings,
        backendSettings,
        credentialStore,
        signalIds,
        cancellable,
        _,
        ngettext,
    } = context;
    const translationPage = new Adw.PreferencesPage({
        title: _('Translation'),
        icon_name: 'preferences-desktop-locale-symbolic',
    });

    const {
        group: translationGroup,
        activeProviderRow,
        activeModelRow,
        saveTargetLanguage,
    } = buildTranslationSettingsGroup(context);
    translationPage.add(translationGroup);

    const providersGroup = new Adw.PreferencesGroup({
        title: _('Model providers'),
        description: _('Save multiple OpenAI-compatible services, fetch their available models, and switch between them.'),
    });
    const addProviderButton = new Gtk.Button({
        label: _('Add provider'),
        valign: Gtk.Align.CENTER,
    });
    addProviderButton.add_css_class('flat');
    providersGroup.set_header_suffix(addProviderButton);
    translationPage.add(providersGroup);

    let providerState = loadTranslationProviders(settings);
    let syncingProviderUi = false;
    let syncingSettings = false;
    let listRefreshGeneration = 0;
    let providerRows = [];
    let activeEditor = null;

    const persistProviders = (providers, activeId) => {
        syncingSettings = true;
        try {
            const saved = saveTranslationProviders(
                backendSettings, providers, activeId);
            if (saved)
                providerState = saved;
            return Boolean(saved);
        } finally {
            syncingSettings = false;
        }
    };

    const providerSummary = (provider, isActive, credentialLabel) => {
        const resolved = resolveTranslationEndpoint(
            provider.endpoint, provider.protocol);
        const protocolLabel = protocolDisplayName(resolved?.protocol);
        const parts = [];
        if (isActive)
            parts.push(_('Active'));
        if (provider.model) {
            parts.push(provider.model);
        } else if (provider.models.length > 0) {
            parts.push(ngettext(
                '%d model', '%d models', provider.models.length)
                .replace('%d', String(provider.models.length)));
        } else {
            parts.push(_('No models configured'));
        }
        parts.push(protocolLabel);
        if (credentialLabel)
            parts.push(credentialLabel);
        return parts.join(' · ');
    };

    const refreshProviderUi = () => {
        if (cancellable.is_cancelled())
            return;
        syncingProviderUi = true;
        try {
            const {providers, activeId} = providerState;
            const activeIndex = Math.max(
                0, providers.findIndex(provider => provider.id === activeId));
            const activeProvider = providers[activeIndex];

            const providerNames = providers.map(provider => provider.name);
            if (!stringListEquals(activeProviderRow.model, providerNames))
                activeProviderRow.model = Gtk.StringList.new(providerNames);
            if (activeProviderRow.selected !== activeIndex)
                activeProviderRow.selected = activeIndex;

            if (activeProvider.models.length > 0) {
                const modelIndex = Math.max(
                    0, activeProvider.models.indexOf(activeProvider.model));
                if (!stringListEquals(activeModelRow.model, activeProvider.models))
                    activeModelRow.model = Gtk.StringList.new(activeProvider.models);
                if (activeModelRow.selected !== modelIndex)
                    activeModelRow.selected = modelIndex;
                activeModelRow.sensitive = true;
                activeModelRow.subtitle = '';
            } else {
                const emptyLabels = [_('No models configured')];
                if (!stringListEquals(activeModelRow.model, emptyLabels))
                    activeModelRow.model = Gtk.StringList.new(emptyLabels);
                if (activeModelRow.selected !== 0)
                    activeModelRow.selected = 0;
                activeModelRow.sensitive = false;
                activeModelRow.subtitle = _(
                    'Open the provider below to fetch or add models');
            }
        } finally {
            syncingProviderUi = false;
        }

        for (const row of providerRows)
            providersGroup.remove(row);
        providerRows = [];

        const refreshGeneration = ++listRefreshGeneration;
        for (const provider of providerState.providers) {
            const isActive = provider.id === providerState.activeId;
            const row = new Adw.ActionRow({
                title: provider.name,
                subtitle: providerSummary(provider, isActive, null),
                activatable: true,
                use_markup: false,
            });
            if (!isActive) {
                const useButton = new Gtk.Button({
                    label: _('Use'),
                    valign: Gtk.Align.CENTER,
                });
                useButton.add_css_class('flat');
                useButton.connect('clicked', () => {
                    persistProviders(providerState.providers, provider.id);
                    refreshProviderUi();
                });
                row.add_suffix(useButton);
            }
            row.add_suffix(new Gtk.Image({
                icon_name: 'go-next-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            }));
            row.connect('activated', () =>
                openProviderEditor(context, providerStore, provider.id));
            providersGroup.add(row);
            providerRows.push(row);

            credentialStore.isConfigured(provider.id, cancellable).then(
                configured => {
                    if (cancellable.is_cancelled() ||
                        refreshGeneration !== listRefreshGeneration)
                        return;
                    row.subtitle = providerSummary(
                        provider,
                        isActive,
                        configured ? _('API key saved') : _('API key not set'));
                }).catch(() => {
                    if (cancellable.is_cancelled() ||
                        refreshGeneration !== listRefreshGeneration)
                        return;
                    row.subtitle = providerSummary(
                        provider, isActive, _('Secret Service unavailable'));
                });
        }
    };

    const providerStore = {
        get state() {
            return providerState;
        },
        get activeEditor() {
            return activeEditor;
        },
        set activeEditor(value) {
            activeEditor = value;
        },
        persist: persistProviders,
        refreshUi: refreshProviderUi,
    };

    activeProviderRow.connect('notify::selected', () => {
        if (syncingProviderUi)
            return;
        const selected = providerState.providers[activeProviderRow.selected];
        if (!selected || selected.id === providerState.activeId)
            return;
        persistProviders(providerState.providers, selected.id);
        refreshProviderUi();
    });

    activeModelRow.connect('notify::selected', () => {
        if (syncingProviderUi || !activeModelRow.sensitive)
            return;
        const activeProvider = providerState.providers.find(
            provider => provider.id === providerState.activeId);
        const selectedModel = activeProvider?.models[activeModelRow.selected];
        if (!activeProvider || !selectedModel ||
            activeProvider.model === selectedModel)
            return;
        const updated = providerState.providers.map(provider =>
            provider.id === activeProvider.id
                ? {...provider, model: selectedModel}
                : provider);
        persistProviders(updated, providerState.activeId);
        refreshProviderUi();
    });

    addProviderButton.connect('clicked', () =>
        openProviderEditor(context, providerStore, null));
    refreshProviderUi();

    const syncProvidersFromSettings = () => {
        if (syncingSettings || cancellable.is_cancelled())
            return;
        providerState = loadTranslationProviders(settings);
        refreshProviderUi();
        if (activeEditor && !activeEditor.isNew) {
            const updated = providerState.providers.find(
                provider => provider.id === activeEditor.id);
            activeEditor.syncFromState(updated);
        }
    };
    for (const key of [
        'translation-providers',
        'translation-provider',
        'translation-api-endpoint',
        'translation-api-protocol',
        'translation-model',
    ])
        signalIds.push(settings.connect(`changed::${key}`, syncProvidersFromSettings));

    signalIds.push(settings.connect(
        'changed::translation-credential-generation', () => {
            activeEditor?.onCredentialChanged();
            refreshProviderUi();
        }));

    return {
        page: translationPage,
        onClose: () => {
            saveTargetLanguage();
            activeEditor?.onWindowClose();
        },
    };
}

export default class LyricGlancePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const backendSettings = this.getSettings();
        backendSettings.delay();
        const signalIds = [];
        const cancellable = new Gio.Cancellable();
        const context = {
            window,
            settings,
            backendSettings,
            credentialStore: new TranslationCredentialStore(),
            signalIds,
            cancellable,
            _: this.gettext.bind(this),
            ngettext: this.ngettext.bind(this),
        };
        window.search_enabled = true;

        window.add(buildGeneralPage(context));
        const translation = buildTranslationPage(context);
        window.add(translation.page);

        window.connect('close-request', () => {
            translation.onClose();
            cancellable.cancel();
            for (const id of signalIds)
                settings.disconnect(id);
            signalIds.length = 0;
            return false;
        });
    }
}
