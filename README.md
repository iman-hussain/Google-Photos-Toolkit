# Google Photos Toolkit (Swipe)

Bulk organize your media, plus a swipe mode for going through it one photo at a time.

> **This is a fork.** Google Photos Toolkit (GPTK) is created and maintained by [xob0t](https://github.com/xob0t), at [xob0t/Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit). All of the toolkit itself is their work: the reverse-engineered Google Photos web API, the filters and the bulk actions. This fork by [iman-hussain](https://github.com/iman-hussain) only adds swipe mode and the Chrome extension packaging on top, and is not affiliated with or endorsed by the original author. It's released under the same [MIT licence](LICENSE), with xob0t's copyright notice kept as the licence requires.

![demo](media/demo.png)

## How It Works

In your browser, utilizing GP's undocumented web api

## How To Install

### Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) userscript manager for your browser
   - If you're on Android, try [Firefox](https://www.mozilla.org/firefox/browsers/mobile/android/), it supports Tampermonkey
2. Click [Install](https://github.com/iman-hussain/Google-Photos-Toolkit/releases/latest/download/google_photos_toolkit_swipe.user.js)
3. Accept installation

If you have the original GPTK userscript installed too, disable one of them, they'll both add buttons.

### Chrome extension

1. Download `google_photos_toolkit_swipe_extension.zip` from the [latest release](https://github.com/iman-hussain/Google-Photos-Toolkit/releases/latest) and unzip it (or run `pnpm build` and use `dist/`)
2. Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the folder
3. Open Google Photos. Clicking the extension's toolbar icon opens swipe mode

### One folder, both ways

`pnpm build` puts everything in `dist/`. That folder is the unpacked extension, and the `google_photos_toolkit_swipe.user.js` inside it is the userscript. It's the same file either way: under Tampermonkey it uses `unsafeWindow` and the menu API, as an extension content script it falls back to the page's `window`. Use one or the other, not both at once.

## Swipe mode

Open it from the swipe button in the Google Photos header, the Tampermonkey menu, or the extension icon.

Pick a day, week, month or year (or the whole library) and you get one photo at a time, newest first.

**Picking a period**: click the period name in the toolbar (or press `C`) to open the calendar. It shows every year as a row of months. Click a month to see its weeks and days on the right, then click a week or a day to review just that, or "Review" for the whole month. Double-click a month or year to jump straight in. "Count photos" walks the library once (a few minutes for a big library) so each cell also shows how many photos it holds, and empty months are greyed out.

**Ticking off what you've sorted**: finishing a period marks it sorted automatically, and you can mark any period by hand with "Mark sorted" (`M`). In the calendar, tick-off mode lets you click through months, weeks or days to mark them in bulk, for example everything you'd already cleaned up before using this. Sorted periods show a tick, in-progress ones show how many you've reviewed, and anything inside a sorted month or year counts as sorted. "Next unsorted" (`N`) skips straight to the next older period you haven't done.

| Key | Button | Does |
|---|---|---|
| `←` / `A` | Delete | Bin, delete album or archive, depending on settings |
| `→` / `D` | Keep | Marks it reviewed, nothing changes in Google Photos |
| `↑` / `W` | Favourite | Stars it and keeps it |
| `↓` / `S` | Sort later | Adds it to a "Sort later" album |
| `Z` / `Backspace` | Undo | Reverses the last action and shows the photo again |
| `[` / `]` | | Older / newer period |
| `N` | Next unsorted | Next older period that isn't sorted (and has photos, once counted) |
| `C` | Calendar | Open the period picker |
| `M` | Mark sorted | Mark the current period sorted, or unmark it |
| `V` | | Video sound on / off (videos play inline, muted) |
| `O` | | Open the photo in Google Photos |

You can also drag the photo left, right, up or down.

**Delete options** (Settings): move to Bin (recoverable for 60 days), add to a "To delete" album so nothing is actually binned until you decide, or archive. To bin everything in the delete album later, use the main GPTK window with that album as the source and "Move to trash".

**Picking up where you left off**: every decision is remembered per Google account, so reviewed photos are skipped next time, and each period resumes from the last photo you were on. "Review this period again" in the empty state, or "Forget all reviewed" in settings, resets that.

**History**: every action is logged with enough detail to undo it. From the History panel you can:

- export the log as `.ndjson` (for reverting) or `.csv` (for reading)
- revert from this browser's log or from an exported file, filtered by session, date and action type

Reverting restores from Bin, unarchives, unfavourites (only if it wasn't a favourite before) and removes items from the albums they were added to.

### Large libraries

Swipe mode is built to cope with hundreds of thousands of items:

- the timeline is streamed a page at a time and only a few hundred items are held in memory, whatever the period size
- only the current photo and the next three are loaded, at screen resolution
- reviewed marks and the log live in IndexedDB, not in memory or localStorage
- export and import stream line by line
- Google Photos calls run in a small background queue, so swiping never waits on the network

### Finding space-consuming media

This example groups all space-consuming media in one album.

1. Make sure "Library" is the selected source
2. Select `SPACE-CONSUMING` in the `Space` filter
3. Select action `Add to new album`

### Identify media not in any albums

Select all albums in the `Exclude albums` filter, then use appropriate action.

### Identifying duplicates/similar images

Use `Similarity` filter with action `Add to new album`
Media with similar thumbnails will be added to the album.

### Deleting all media in the library

As simple as selecting "Library" source, clicking `Move to trash`, then clearing it.

### Use GPTK's api

GPTK exports it's api class globally so you can use it in your browser's console.  
It's much more powerful than the UI!

Example usage.
Scan the whole library for media owned by `ownerName` and move it to trash if found.

```js
let nextPageId = null;
const ownerName = 'John';
do {
  const page = await gptkApi.getItemsByUploadedDate(nextPageId);
  for (const item of page.items) {
    if (item.isOwned) continue;
    const itemInfo = await gptkApi.getItemInfoExt(item.mediaKey);
    console.log(`${item.mediaKey} is shared by ${itemInfo.owner.name}`);
    if (itemInfo.owner.name == ownerName) {
      await gptkApi.moveItemsToTrash([itemInfo.dedupKey]);
      console.log(`${item.mediaKey} moved to trash`);
    }
  }
  nextPageId = page.nextPageId;
} while (nextPageId);
console.log('DONE');
```

## Contributions welcome

*From xob0t, the original author:*

If you want to learn more about how GP's api works, read [https://kovatch.medium.com/deciphering-google-batchexecute-74991e4e446c](https://kovatch.medium.com/deciphering-google-batchexecute-74991e4e446c)  
I just found this post, after doing all the work from zero :D

Also, i've made a userscript that parses all responses and logs them to console in a more readable way, you can find it here - [https://github.com/xob0t/Google-Photos-Toolkit/tree/main/tools](https://github.com/xob0t/Google-Photos-Toolkit/tree/main/tools)

## BUGS

Problems with swipe mode or the Chrome extension belong to this fork: open an [issue here](https://github.com/iman-hussain/Google-Photos-Toolkit/issues), not upstream.

For the toolkit itself, first check it also happens with the [original userscript](https://github.com/xob0t/Google-Photos-Toolkit). If it does, open an [issue](https://github.com/xob0t/Google-Photos-Toolkit/issues) or a [discussion](https://github.com/xob0t/Google-Photos-Toolkit/discussions) there and describe it in detail.

## Credits

- [xob0t](https://github.com/xob0t) created [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit), which this fork is built on, along with its other contributors
- GPTK borrowed some code and UI inspiration from [undiscord](https://github.com/victornpb/undiscord)
- Swipe mode and the extension packaging are by [iman-hussain](https://github.com/iman-hussain)

## xob0t's other Google Photos projects

- Python client with unlimited uploads: [https://github.com/xob0t/gphotos_mobile_client](https://github.com/xob0t/gphotos_mobile_client)
- Disguise any file as media for GP to accept and store it: [https://github.com/xob0t/gp-file-hide](https://github.com/xob0t/gp-file-hide)

## ♥

If GPTK is useful to you, please consider supporting its original author, xob0t:

BTC `12znTocLytrrYhQT4AJVeJdR8KTULWbKb7`  
BTC Cash `qq7w48d6s3rddgxshl6ae48k7c5jyck76crvppqenn`  
DOGE `DQjBzT2qMuXkLMawUXG7umTf3k9VeT4Y6K`  
Etherium `0xcfe559D9F6056F82a6CFdEDA51c00132035955c8`  
Litecoin `ltc1qcgc873py5k28qm85sk5d53yfwzle4cztmvkh6l`

## Licence

MIT, see [LICENSE](LICENSE). The original copyright belongs to xob0t (2024); the swipe mode additions are copyright Iman Hussain (2026) under the same licence. The licence text and both notices are included in the built userscript and extension.
