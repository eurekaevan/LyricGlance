import Secret from 'gi://Secret?version=1';

function attributes(provider) {
    return {provider: String(provider)};
}

function secretError() {
    // Do not propagate provider headers, request objects, or credential values
    // into Preferences or the Shell journal.
    return new Error('Secret Service operation failed');
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
                    } catch {
                        reject(secretError());
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
                    } catch {
                        reject(secretError());
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
                    } catch {
                        reject(secretError());
                    }
                });
        });
    }
}
