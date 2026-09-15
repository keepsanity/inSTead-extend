# inSTead-extend

A personal fork of [inSTead](https://github.com/ActualBroeckchen/inSTead) for revising SillyTavern messages with feedback and reusable rules.

## Features

- Global and character-specific rules, selectable for each revision.
- Optional character card, active lore, and full chat history before the message being revised.
- A separate connection profile for revisions.
- New swipes that preserve the original, with an option to replace a previous revision.
- Trailing status/info block preservation.

Leave all context options off to send only the passage, rules, and feedback. Lore follows the connected lorebooks' activation rules and budget in Quiet mode. Full history is not trimmed and can exceed the model's context limit in long chats.

## Install

In SillyTavern, open **Extensions → Install Extension** and paste:

```text
https://github.com/keepsanity/inSTead-extend
```

Enable **Connection Manager** and select a supported Chat Completion or Text Completion profile in the inSTead settings.

## Use

1. Open a character message's **⋯** menu and click the revision icon.
2. Choose rules and optional context, then enter any feedback.
3. Click **Send**. The revision appears as a new swipe.

## Credits

Original extension by [ActualBroeckchen](https://github.com/ActualBroeckchen/inSTead). Fork maintained by [keepsanity](https://github.com/keepsanity).

MIT License, as stated in the original project.
