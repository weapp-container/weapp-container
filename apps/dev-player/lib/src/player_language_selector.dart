import 'package:flutter/material.dart';

import 'player_localizations.dart';
import 'player_preferences.dart';

Future<void> showPlayerLanguageDialog(
  BuildContext context,
  PlayerPreferences preferences,
) => showDialog<void>(
  context: context,
  builder: (context) => AlertDialog(
    title: Text(playerStrings(context).languageAndEnglish),
    content: SizedBox(
      width: 320,
      child: PlayerLanguageSelector(preferences: preferences, showLabel: false),
    ),
  ),
);

/// Only changes host UI preferences, never the guest's session or language.
class PlayerLanguageSelector extends StatefulWidget {
  const PlayerLanguageSelector({
    super.key,
    required this.preferences,
    this.showLabel = true,
  });

  final PlayerPreferences preferences;
  final bool showLabel;

  @override
  State<PlayerLanguageSelector> createState() => _PlayerLanguageSelectorState();
}

class _PlayerLanguageSelectorState extends State<PlayerLanguageSelector> {
  bool _saving = false;

  Future<void> _select(String? language) async {
    if (language == null || _saving) return;
    setState(() => _saving = true);
    try {
      await widget.preferences.setLanguageCode(language);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(playerStrings(context).languageSaveFailed)),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.preferences,
    builder: (context, _) {
      final dropdown = DropdownButton<String>(
        key: const ValueKey('player-language'),
        value: widget.preferences.languageCode,
        isExpanded: !widget.showLabel,
        onChanged: _saving ? null : _select,
        items: const [
          DropdownMenuItem(value: 'zh', child: Text('简体中文')),
          DropdownMenuItem(value: 'en', child: Text('English')),
        ],
      );
      if (!widget.showLabel) return dropdown;
      return ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.language),
        title: Text(playerStrings(context).languageAndEnglish),
        trailing: dropdown,
      );
    },
  );
}
