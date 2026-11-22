import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret?version=1';

function attributes(provider) {
    return {provider: String(provider)};
}

function secretError(error) {
    if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
        return new GLib.Error(
            Gio.IOErrorEnum,
            Gio.IOErrorEnum.CANCELLED,
            'Operation was cancelled');
    }
    // Do not propagate provider headers, request objects, or credential values
    // into Preferences or the Shell journal.
    return new Error('Secret Service operation failed');
}

export function isValidCredential(password) {
    if (typeof password !== 'string')
        return false;
    const trimmed = password.trim();
    return Boolean(trimmed) && /^[\x21-\x7E]+$/.test(trimmed);
}

export class TranslationCredentialStore {
    get _schema() {
        this._secretSchema ??= new Secret.Schema(
            'org.gnome.shell.extensions.lyric-glance.translation',
            Secret.SchemaFlags.NONE,
            {provider: Secret.SchemaAttributeType.STRING});
        return this._secretSchema;
    }

    lookup(provider, cancellable = null) {
        return new Promise((resolve, reject) => {
            Secret.password_lookup(
                this._schema,
                attributes(provider),
                cancellable,
                (_source, result) => {
                    try {
                        resolve(Secret.password_lookup_finish(result));
                    } catch (error) {
                        reject(secretError(error));
                    }
                });
        });
    }

    async isConfigured(provider, cancellable = null) {
        return Boolean(await this.lookup(provider, cancellable));
    }

    store(provider, password, cancellable = null) {
        if (typeof password !== 'string' || !password.trim())
            return Promise.reject(new Error('API credential cannot be empty'));
        if (!isValidCredential(password)) {
            return Promise.reject(
                new Error('API credential contains invalid characters'));
        }

        return new Promise((resolve, reject) => {
            Secret.password_store(
                this._schema,
                attributes(provider),
                Secret.COLLECTION_DEFAULT,
                `LyricGlance ${provider} translation API key`,
                password.trim(),
                cancellable,
                (_source, result) => {
                    try {
                        resolve(Secret.password_store_finish(result));
                    } catch (error) {
                        reject(secretError(error));
                    }
                });
        });
    }

    clear(provider, cancellable = null) {
        return new Promise((resolve, reject) => {
            Secret.password_clear(
                this._schema,
                attributes(provider),
                cancellable,
                (_source, result) => {
                    try {
                        resolve(Secret.password_clear_finish(result));
                    } catch (error) {
                        reject(secretError(error));
                    }
                });
        });
    }
}
