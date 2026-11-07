import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Gio.File.prototype,
    'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype,
    'replace_contents_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype,
    'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype,
    'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype,
    'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype,
    'set_attributes_async', 'set_attributes_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'close_async', 'close_finish');
Gio._promisify(Gio.InputStream.prototype,
    'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype,
    'close_async', 'close_finish');
Gio._promisify(Soup.Session.prototype,
    'send_async', 'send_finish');
Gio._promisify(Gio.File.prototype,
    'load_contents_async', 'load_contents_finish');
