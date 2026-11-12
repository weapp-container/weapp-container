import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// Preference failures deliberately exclude filesystem paths and file contents.
class PlayerPreferencesException implements Exception {
  const PlayerPreferencesException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => '$code: $message';
}

/// Player UI preferences are separate from credentials and mini-program data.
class PlayerPreferences extends ChangeNotifier {
  PlayerPreferences._(
    this._file,
    this._languageCode, {
    bool storageUnavailable = false,
  }) : _storageUnavailable = storageUnavailable;

  factory PlayerPreferences.memory({String languageCode = 'zh'}) {
    _validateLanguageCode(languageCode);
    return PlayerPreferences._(null, languageCode);
  }

  /// Allows the Player to open when optional preference storage cannot start.
  /// Unlike memory mode, user changes fail rather than pretending to be saved.
  factory PlayerPreferences.unavailable() =>
      PlayerPreferences._(null, _defaultLanguageCode, storageUnavailable: true);

  static const _schemaVersion = 1;
  static const _defaultLanguageCode = 'zh';

  final File? _file;
  final bool _storageUnavailable;
  String _languageCode;
  Future<void> _pending = Future<void>.value();
  bool _disposed = false;

  String get languageCode => _languageCode;
  Locale get locale => Locale(_languageCode);

  /// Storage initialization must not keep the entire Player from starting.
  /// Programming errors and unrelated preference failures remain visible.
  static Future<PlayerPreferences> loadOrDefault({File? file}) async {
    try {
      return await load(file: file);
    } on PlayerPreferencesException catch (error) {
      if (error.code != 'ERR_PREFERENCES_STORAGE') rethrow;
      return PlayerPreferences.unavailable();
    }
  }

  /// Unsupported or unreadable data falls back without rewriting the original.
  static Future<PlayerPreferences> load({File? file}) async {
    final File preferencesFile;
    try {
      preferencesFile =
          file ??
          File(
            p.join(
              (await getApplicationSupportDirectory()).path,
              'preferences.json',
            ),
          );
    } on Exception catch (error) {
      if (error is! MissingPlatformDirectoryException &&
          error is! PlatformException &&
          error is! MissingPluginException &&
          error is! FileSystemException) {
        rethrow;
      }
      throw _storageFailure;
    }
    var languageCode = _defaultLanguageCode;
    try {
      final value = jsonDecode(await preferencesFile.readAsString());
      if (value is Map &&
          value['schemaVersion'] == _schemaVersion &&
          _isSupportedLanguageCode(value['languageCode'])) {
        languageCode = value['languageCode'] as String;
      }
    } on FileSystemException {
      // Missing and unreadable files preserve the source.
    } on FormatException {
      // Invalid UTF-8/JSON also preserves the source.
    }
    return PlayerPreferences._(preferencesFile, languageCode);
  }

  /// Changes settle in request order; a failed write never poisons the queue.
  Future<void> setLanguageCode(String value) {
    try {
      _validateLanguageCode(value);
      if (_disposed) {
        throw const PlayerPreferencesException(
          'ERR_PREFERENCES_DISPOSED',
          'Player preferences are no longer available.',
        );
      }
      if (_storageUnavailable) throw _storageFailure;
    } catch (error, stack) {
      return Future<void>.error(error, stack);
    }
    final operation = _pending.then((_) => _saveLanguageCode(value));
    _pending = operation.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return operation;
  }

  Future<void> _saveLanguageCode(String value) async {
    final file = _file;
    if (file != null) {
      Directory? staging;
      try {
        await file.parent.create(recursive: true);
        staging = await file.parent.createTemp('.preferences-');
        final temporary = File(p.join(staging.path, 'preferences.json'));
        await temporary.writeAsString(
          jsonEncode({'schemaVersion': _schemaVersion, 'languageCode': value}),
          flush: true,
        );
        // The temporary file shares the destination filesystem. Readers see
        // either the prior complete preference file or the replacement.
        await temporary.rename(file.path);
      } catch (_) {
        throw const PlayerPreferencesException(
          'ERR_PREFERENCES_WRITE',
          'Player preferences could not be saved.',
        );
      } finally {
        if (staging != null) {
          try {
            await staging.delete(recursive: true);
          } catch (_) {
            // Cleanup must not turn a committed language change into a failure.
          }
        }
      }
    }
    if (_languageCode != value) {
      _languageCode = value;
      if (!_disposed) notifyListeners();
    }
  }

  static bool _isSupportedLanguageCode(Object? value) =>
      value == 'zh' || value == 'en';

  static const _storageFailure = PlayerPreferencesException(
    'ERR_PREFERENCES_STORAGE',
    'Player preferences storage is unavailable.',
  );

  static void _validateLanguageCode(String value) {
    if (!_isSupportedLanguageCode(value)) {
      throw const PlayerPreferencesException(
        'ERR_PREFERENCES_LANGUAGE',
        'Only Chinese and English are supported.',
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
