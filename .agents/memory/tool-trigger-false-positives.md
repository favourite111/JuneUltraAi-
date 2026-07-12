---
name: Tool trigger false positives from passive mentions
description: Why keyword-based tool matchers must gate on intent, not just phrase presence, to avoid firing on casual mentions.
---

A tool matcher that fires on "trigger phrase present + non-empty leftover text after stripping filler words" will false-positive on passive, past-tense mentions — e.g. "I saw a QR code on a billboard" was treated as a request to generate one, because stripping "qr code"/"a"/"on" still left non-empty text ("I saw billboard"), which the code treated as valid payload/intent.

**Why:** Presence of a domain noun ("qr code", "screenshot", "pdf") is not the same as a request. People discuss these things in ordinary conversation without asking the bot to act.

**How to apply:** For any new keyword-triggered tool, require a real intent signal in addition to the phrase — an action verb (generate/create/make/need/want/give me/send me) or a structural clue that names a payload (a "for"/":" clause, or — like the URL shortener/screenshot tools — an actual URL in the message). Test candidate matchers against realistic passive-mention sentences, not just the intended command phrasing, before shipping.
