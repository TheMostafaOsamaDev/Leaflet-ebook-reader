// English UI catalog — the SOURCE OF TRUTH for message keys. Every key here
// MUST have an Arabic counterpart in ./ar.ts (the `Messages` type makes a
// missing key a compile error). Keys are flat + dot-namespaced.
export const en = {
  // common (reused across surfaces)
  "common.close": "Close",
  "common.cancel": "Cancel",
  "common.back": "Back",
  "common.retry": "Retry",
  "common.confirm": "Confirm",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.undo": "Undo",
  // Display-time fallback for a blank `Book.author` — NEVER persist this
  // string itself into data (a UI-locale string baked into a data field
  // would freeze in whatever language was active at save time and stay
  // wrong forever after). Apply only at read-only display sites, e.g.
  // `book.author || tr(...)` in BookCover/Library — never in an editable
  // input's `value`.
  "common.unknownAuthor": "Unknown author",
  // Display-time (and, for the source parsers, synthesis-time — see
  // `currentUiLocale()` in cenele.ts/kolnovel-theme.ts) fallback for a title
  // that couldn't be determined (no <dc:title> in an EPUB, an unusable docx
  // filename, or a scraped novel page missing its title element). Same
  // never-persist-untranslated-English rationale as `common.unknownAuthor`.
  "common.untitled": "Untitled",

  // settings panel
  "settings.title": "Reading",
  "settings.subtitle": "Appearance & typography",
  "settings.language": "Language",
  "settings.language.auto": "Auto",
  "settings.theme": "Theme",
  "settings.theme.system": "System",
  "settings.theme.systemHint": "Follows your OS light / dark setting",
  "settings.theme.systemHintDevice": "Follows your device's light / dark setting",
  "settings.theme.light": "Light",
  "settings.theme.sepia": "Sepia",
  "settings.theme.dark": "Dark",
  "settings.theme.oled": "OLED",
  "settings.font": "Font",
  "settings.fontGroup.naskh": "Naskh · book faces",
  "settings.fontGroup.modern": "Modern sans",
  "settings.fontGroup.kufi": "Kufi",
  "settings.fontGroup.display": "Display",
  "settings.fontSize": "Font size · {n}px",
  "settings.lineHeight": "Line height · {n}",
  "settings.letterSpacing": "Letter spacing · {n}em",
  "settings.contentWidth": "Content width · {n}%",
  "settings.alignment": "Alignment",
  "settings.align.auto": "Auto",
  "settings.align.left": "Left",
  "settings.align.justify": "Justify",
  "settings.align.right": "Right",
  "settings.readingMode": "Reading mode",
  "settings.mode.paginated2": "Two pages",
  "settings.mode.paginated1": "Single page",
  "settings.mode.scroll": "Scroll",
  "settings.on": "On",
  "settings.off": "Off",

  // fixed-layout (PDF / DOCX) page controls. These live beside the reflow
  // controls above because both readers render them through the same
  // SettingsPanel — see `fixedItems()` in components/SettingsSection.tsx.
  "settings.subtitle.fixed": "Appearance & page layout",
  "settings.flow": "Flow",
  "settings.flow.scroll": "Scroll",
  "settings.flow.paged": "Page",
  "settings.fit": "Fit",
  "settings.fit.width": "Width",
  "settings.fit.page": "Page",
  "settings.pageTint": "Page tint",
  "settings.pageTint.none": "None",
  "settings.pageTint.dim": "Dim",
  "settings.pageTint.invert": "Invert",
  "settings.zoom": "Zoom",
  "settings.zoom.in": "Zoom in",
  "settings.zoom.out": "Zoom out",

  // reader quick-panel → full settings page
  "settings.openFull": "All settings",
  "settings.openFull.hint": "Language, downloads, data & more",

  // settings page — section titles
  "settings.section.appearance": "Appearance",
  "settings.section.reading": "Reading",
  "settings.section.behavior": "Behavior",
  "settings.section.downloads": "Downloads",
  "settings.section.data": "Data",
  "settings.section.about": "About",

  // settings nav + scoped search
  "settings.search": "Search settings",
  "settings.searchNoResults": "No matching settings",

  // appearance

  // reading (new)
  "settings.paragraphSpacing": "Paragraph spacing · {n}",
  "settings.hyphenation": "Hyphenation",
  "settings.pageTurnAnimation": "Page-turn animation",
  "settings.keepScreenAwake": "Keep screen awake",
  "settings.keepScreenAwake.hint": "Best-effort — may not work on every device.",

  // behavior
  "settings.startupView": "On startup",
  "settings.startup.library": "Library",
  "settings.startup.resume": "Resume last book",
  "settings.confirmDelete": "Confirm before deleting",
  "settings.reduceMotion": "Reduce motion",
  "settings.reduceMotion.auto": "Auto",

  // downloads
  "settings.maxConcurrentDownloads": "Simultaneous downloads · {n}",
  "settings.wifiOnly": "Wi-Fi-only downloads",
  "settings.wifiOnly.hint":
    "Best-effort — only enforced where the system reports the connection type.",

  // data
  "settings.exportSettings": "Export settings",
  "settings.importSettings": "Import settings",
  "settings.resetSettings": "Reset to defaults",
  "settings.reset.confirmTitle": "Reset all settings?",
  "settings.reset.confirmBody":
    "Every setting returns to its default. Your books and reading progress are not affected.",
  "settings.reset.confirmCta": "Reset",
  "settings.exportError": "Couldn't save settings",
  "settings.exportDone": "Settings exported",
  "settings.importDone": "Settings imported",
  "settings.importError": "Couldn't read that settings file",

  // about
  "settings.about.tagline": "A calm, offline-first reader.",
  "settings.about.version": "Version {n}",
  "settings.about.sourceCode": "Source code",
  "settings.about.license": "License",

  // app-root
  "app.loadingBook": "Loading book…",
  "panel.close": "Close panel",

  // drag-and-drop overlay (DropOverlay.tsx)
  "drop.accept": "Drop to add",
  "drop.acceptCountOne": "{count} book",
  "drop.acceptCountOther": "{count} books",
  "drop.refuse": "Riwaq can't read this",
  "drop.formats": "EPUB · PDF · DOCX",
  // Not "Added to your library": this fires the instant the drop/arrival
  // lands, before anything has actually imported — most visibly wrong for
  // a drop while reading, which is the exact case this confirmation exists
  // for, and it stays wrong if the import later fails. "Queued" is true
  // the moment it's shown.
  "drop.received": "Queued for import",
  "drop.skippedOne": "Skipped {count} file Riwaq can't read.",
  "drop.skippedOther": "Skipped {count} files Riwaq can't read.",

  // library sidebar
  "sidebar.searchLibrary": "Search library",
  "sidebar.main": "Main",
  "sidebar.library": "Library",
  "sidebar.reading": "Reading",
  "sidebar.finished": "Finished",
  "sidebar.wishlist": "Wishlist",
  "sidebar.store": "Store",
  "sidebar.shelves": "Shelves",
  "sidebar.newShelf": "New shelf",
  "sidebar.downloads": "Downloads",
  "sidebar.settings": "Settings",
  "nav.back": "Back",
  "nav.forward": "Forward",
  "sidebar.importBook": "Import book",
  "sidebar.importing": "Importing…",
  "sidebar.moreImport": "More import options",
  "sidebar.folderOfBooks": "Folder of books",
  "sidebar.expand": "Expand {name}",
  "sidebar.collapse": "Collapse {name}",
  "sidebar.doubleClickExpand": "Double-click to expand",
  "sidebar.doubleClickCollapse": "Double-click to collapse",

  // library home (shelf grid, hero, tabs, empty/error states, mobile nav)
  "library.loading": "Loading your library…",
  "library.loadingShort": "Loading…",
  "library.yourShelf": "Your shelf",
  "library.currentlyReading": "Currently reading",
  "library.shelf": "Shelf",
  "library.bookCountOne": "{n} book · sorted by recent",
  "library.bookCountOther": "{n} books · sorted by recent",
  "library.continueReading": "Continue reading",
  "library.continue": "Continue",
  "library.startReading": "Start reading",
  "library.byAuthorChapters": "by {author} · {n} chapters",
  "library.chaptersAgo": "{n} chapters · {rel}",
  "library.justNow": "just now",
  "library.minAgo": "{n}m ago",
  "library.hourAgo": "{n}h ago",
  "library.dayAgo": "{n}d ago",
  "library.weekAgo": "{n}w ago",
  "library.monthAgo": "{n}mo ago",
  "library.resumeReadingCta": "Resume reading →",
  "library.startReadingCta": "Start reading →",
  "library.editDetails": "Edit details",
  "library.removeFromLibrary": "Remove from library",
  "library.emptyTitle": "Your shelf is empty",
  "library.emptyBody":
    "Import an EPUB to start reading. Riwaq parses it locally — no uploads, no accounts.",
  "library.emptyCta": "Import your first EPUB",
  "library.emptyReading": "No books marked as reading yet.",
  "library.emptyFinished": "No finished books yet.",
  "library.emptyWishlist": "Nothing on your wishlist yet.",
  "library.emptyGeneric": "Nothing here.",
  "library.setStatusHint": "Right-click a book to set its status.",
  "library.newBadge": "New",
  "library.newBadgeAriaLabel": "New — not started yet",
  "library.importFailedPrefix": "Import failed:",
  "library.removeConfirmTitle": "Remove from library?",
  "library.removeConfirmSuffix":
    "will be removed from your library, including its reading progress. This can't be undone.",
  "library.remove": "Remove",
  "library.backToLibrary": "Back to library",
  "library.openStore": "Open store",
  "library.openDownloads": "Open downloads",
  "library.importEpub": "Import EPUB",
  "library.scrollTabsStart": "Scroll tabs back",
  "library.scrollTabsEnd": "Scroll tabs forward",

  // shelves page + new-shelf dialog
  "shelves.title": "Shelves",
  "shelves.countOne": "{n} shelf · your collections",
  "shelves.countOther": "{n} shelves · your collections",
  "shelves.newShelf": "New shelf",
  "shelves.empty": "No shelves yet",
  "shelves.emptyHint": "Create a shelf to group books your way.",
  "shelves.dialogHint": "Name a collection. You can add books to it later.",
  "shelves.namePlaceholder": "e.g. Favorites, Summer reads…",
  // Seed names for the first-run shelf list (LibraryLayout — not persisted
  // yet, so these must track the current locale rather than freeze English).
  "shelves.defaultFavorites": "Favorites",
  "shelves.defaultToRead": "To read",
  "shelves.duplicateName": "A shelf with that name already exists.",
  "shelves.create": "Create shelf",
  "shelves.rename": "Rename",
  "shelves.renameTitle": "Rename shelf",
  "shelves.renameConfirm": "Save",
  "shelves.delete": "Delete",
  "shelves.deleteTitle": "Delete shelf",
  "shelves.deleteBody": "Books won't be deleted — they stay in your library.",
  "shelves.deleteConfirm": "Delete shelf",
  "shelves.addBook": "Add a book",
  "shelves.addFromLibrary": "From library",
  "shelves.addFromDevice": "From device",
  "shelves.pickerTitle": "Add to {shelf}",
  "shelves.pickerSearch": "Search your library",
  "shelves.pickerAdd": "Add ({n})",
  "shelves.pickerEmpty": "No books in your library yet.",
  "shelves.onShelf": "On shelf",
  "shelves.removeFromShelf": "Remove from shelf",
  "shelves.removedToast": "Removed from {shelf}",
  "shelves.addedToast": "Added {n} to {shelf}",
  "shelves.keepTitle": "Keep “{title}” in your library?",
  "shelves.keepBody": "This book isn't on any other shelf.",
  "shelves.keepInLibrary": "Keep in library",
  "shelves.bookCountOne": "{n} book",
  "shelves.bookCountOther": "{n} books",
  "shelves.shelfOptions": "{shelf} options",

  // reader chrome (desktop + mobile toolbars, chapter progress, mobile sheet)
  "reader.backToLibrary": "Back to library",
  "reader.prevChapter": "Previous chapter",
  "reader.nextChapter": "Next chapter",
  "reader.endOfChapter": "End of chapter",
  "reader.endOfBook": "End of the book",
  "reader.savedOnDevice": "Saved on device",
  "reader.needsConnection": "Needs a connection",
  "reader.chapterProgress": "Chapter progress",
  "reader.toc": "Table of contents",
  "reader.highlights": "Highlights",
  "reader.progress": "Progress",
  "reader.settings": "Settings",
  "reader.chapterOfTotal": "Chapter {n} of {total}",
  "reader.chapterDash": "Chapter {n} — {title}",
  "reader.keepScrollingNext": "Keep scrolling for next chapter",
  "reader.keepScrollingPrev": "Keep scrolling for previous chapter",
  "reader.hideProgressBar": "Hide progress bar",
  "reader.showProgressBar": "Show progress bar",
  "reader.readingSettings": "Reading settings",
  "reader.readingProgress": "Reading progress",

  // Chapter-image lightbox (Lightbox.tsx) — full-viewport image viewer
  // opened by tapping an inline chapter image.
  "lightbox.closeImage": "Close image",

  // TOC panel (reuses reader.toc for its own title — see PanelShell usage)
  "toc.searchChapters": "Search chapters",
  "toc.clearSearch": "Clear search",
  "toc.noMatches": "No chapters match “{term}”.",
  "toc.now": "Now",
  "reader.focusMode": "Focus mode",
  "reader.exitFocusMode": "Exit focus mode",
  "reader.focusHintBody": "Move the pointer to the top or bottom edge to bring the controls back.",
  "toc.collapseAll": "Collapse all volumes",
  "toc.expandAll": "Expand all volumes",
  "toc.goToCurrent": "Go to current chapter",

  // Highlights panel
  "highlights.title": "Highlights",
  "highlights.subtitleNone": "None yet",
  "highlights.subtitleCountOne": "{n} in this book",
  "highlights.subtitleCountOther": "{n} in this book",
  "highlights.emptyTitle": "No highlights yet",
  "highlights.emptyBody":
    "Select text while reading to highlight it, then add a note to remember why it mattered.",
  "highlights.chapterLabel": "Chapter {n}",
  "highlights.pageLabel": "Page {n}",
  "highlights.addNote": "Add note",
  "highlights.editNote": "Edit note",
  "highlights.notePlaceholder": "Note…",
  "highlights.actions": "Highlight actions",
  "highlights.delete": "Delete highlight",
  // Shared by SelectionPopover.tsx (new highlight) and
  // HighlightActionPopover.tsx (existing highlight) — the longer note
  // placeholder shown in each popover's note-composer mode. (The panel's
  // own note field uses the shorter `highlights.notePlaceholder`.)
  "highlights.whyMatterPlaceholder": "Why does this matter?",

  // Text-selection popover (SelectionPopover.tsx, new highlight) — reuses
  // highlights.addNote for its own "Add note" button. Highlight-color swatch
  // aria-labels interpolate one of the color.* names below.
  "selection.ariaLabel": "Highlight options",
  "selection.colorAriaLabel": "Highlight {color}",
  "selection.colorPickAriaLabel": "Color {color}",
  "color.yellow": "yellow",
  "color.blue": "blue",
  "color.pink": "pink",
  "color.green": "green",

  // Progress overlay (heading reuses reader.readingProgress)
  "progress.ofBook": "of book",
  "progress.chapterOfTotal": "chapter {n} of {total}",
  "progress.chaptersLeft": "{n} left",

  // search overlay (⌘K / Ctrl-K command palette)
  "search.placeholder": "Search books, authors…",
  "search.results": "Results",
  "search.noMatches": "No matches — filter the shelf for “{term}”",
  "search.recentSearches": "Recent searches",
  "search.clearHistory": "Clear history",
  "search.removeRecent": "Remove {term}",
  "search.jumpTo": "Jump to",
  "search.websites": "Websites",

  // edit-book modal
  "dialog.editBook.ariaLabel": "Edit book details",
  "dialog.editBook.title": "Edit book",
  "dialog.editBook.subtitle": "Title, author, description, and cover",
  "dialog.editBook.replaceCover": "Replace cover…",
  "dialog.editBook.rescanCover": "Rescan from EPUB",
  "dialog.editBook.fieldTitle": "Title",
  "dialog.editBook.fieldAuthor": "Author",
  "dialog.editBook.fieldDescription": "Description",

  // title + cover dialog shown on PDF/DOCX import
  "dialog.importBook.title": "Import book",
  "dialog.importBook.fieldTitle": "Title",
  "dialog.importBook.cover": "Cover",
  "dialog.importBook.coverFromFile": "Choose image…",
  "dialog.importBook.coverGenerated": "Generated",
  "dialog.importBook.add": "Add to library",
  "dialog.importBook.skip": "Skip",
  "dialog.importBook.skipRest": "Skip the rest",

  // docx import-choice modal
  "import.choice.title": "Import a Word document",
  "import.choice.subtitle": "How would you like to handle this document?",
  "import.choice.directTitle": "Add directly to library",
  "import.choice.directDesc":
    "Convert and import as-is. The first image becomes the cover.",
  "import.choice.manageTitle": "Manage before importing",
  "import.choice.manageDesc":
    "Pick the cover, trim pages, and review images before adding.",

  // docx import-progress modal
  "import.progress.titleFailed": "Import failed",
  "import.progress.titleComplete": "Import complete",
  "import.progress.titleImporting": "Importing document",
  "import.progress.continueInBackground": "Continue in background",
  "import.progress.dismiss": "Dismiss",
  "import.progress.addedToLibrary": "Added to your library.",
  "import.progress.staysRunning": "Stays running if you close this.",
  // Label for the import button while a run is in flight — a tap opens the
  // stepper above rather than the file picker.
  "import.progress.openDetails": "Open import progress",

  // download-range dialog (source-backed novels)
  "downloads.range.title": "Download a chapter range",
  "downloads.range.body":
    "Pick the first and last chapter to include. Chapters are queued for download and show up in the downloads panel — already-downloaded chapters are skipped.",
  "downloads.range.loading": "Loading chapter list…",
  "downloads.range.preloadLabel": "Loading every volume's chapters…",
  "downloads.range.volumeLoadError":
    'Volume "{title}" couldn\'t be loaded — {error}. Range can still target loaded volumes.',
  "downloads.range.needsLibrary":
    "This range download requires the novel to be in your library first.",
  "downloads.range.from": "From",
  "downloads.range.to": "To",
  "downloads.range.selectChapter": "Select a chapter",
  "downloads.range.searchPlaceholder": "Search chapters…",
  "downloads.range.noMatches": "No matching chapters",
  "downloads.range.queueCountOne":
    "{n} chapter will be queued for download{extra}.",
  "downloads.range.queueCountOther":
    "{n} chapters will be queued for download{extra}.",
  "downloads.range.alreadyOnDisk": " ({n} already on disk)",
  "downloads.range.loadingVolumes": "Loading volumes…",
  "downloads.range.nothingToDownload": "Nothing to download",
  "downloads.range.queueButton": "Queue {n}",

  // deleting downloaded chapters
  "downloads.delete.chapterLabel": "Delete download of chapter {n}",
  "downloads.delete.deleted": "Deleted “{title}”",
  "downloads.delete.deletedAndCancelled": "Cancelled and deleted “{title}”",
  "downloads.delete.redownload": "Re-download",
  "downloads.delete.volumeActions": "Volume actions",
  "downloads.delete.deleteRead": "Delete read downloads",
  "downloads.delete.deleteAllInVolume": "Delete all downloads in volume",
  "downloads.delete.nothingToDelete": "No downloads to delete",
  "downloads.delete.confirmTitleOne": "Delete 1 download?",
  "downloads.delete.confirmTitleOther": "Delete {n} downloads?",
  "downloads.delete.confirmBody":
    "These chapters stay in the list and can be read online or downloaded again. Your reading progress is kept.",
  "downloads.delete.confirmButtonOne": "Delete 1",
  "downloads.delete.confirmButtonOther": "Delete {n}",
  "downloads.delete.deletedCountOne": "Deleted 1 download",
  "downloads.delete.deletedCountOther": "Deleted {n} downloads",
  "downloads.delete.selectionCount": "{n} selected",
  "downloads.delete.selectAllDownloaded": "Select all downloaded",
  "downloads.delete.exitSelection": "Exit selection",
  "downloads.delete.selectChapter": "Select chapter {n}: {title}",
  "downloads.delete.downloadedCount": "{n} downloaded",
  "downloads.delete.volumeNotLoaded":
    "Expand this volume to manage its downloads.",
  "downloads.delete.nothingRemoved": "No download on disk for “{title}”",
  "downloads.delete.failed": "Couldn't delete: {error}",
  "downloads.delete.deleting": "Deleting… {done} of {total}",
  "downloads.delete.conversionRunning":
    "A “Save as offline book” job is running for this novel. It will refetch every deleted chapter from the source instead of reading it from disk, which is much slower.",

  // save-as-offline-book dialog
  "downloads.saveOffline.title": "Save as offline book",
  "downloads.saveOffline.loading": "Loading volume listing…",
  "downloads.saveOffline.readError":
    "Couldn't read this novel's snapshot. Try reopening it from the library and try again.",
  "downloads.saveOffline.description":
    "Bakes the novel into a standalone EPUB that lives in your library alongside imported books. Chapters that aren't downloaded yet will be fetched on the fly during conversion. The original entry in your library stays put.",
  "downloads.saveOffline.singleTitle": "Save as one book",
  "downloads.saveOffline.singleDetail":
    "Volumes become sections inside a single EPUB. Best when you read on a tablet or e-reader and prefer one big file.",
  "downloads.saveOffline.perVolumeTitle": "Save each volume as its own book",
  "downloads.saveOffline.perVolumeDetailOne":
    "Creates {n} separate EPUB in your library, one per volume. Better for novels with many volumes; you can read one at a time and finish it cleanly.",
  "downloads.saveOffline.perVolumeDetailOther":
    "Creates {n} separate EPUBs in your library, one per volume. Better for novels with many volumes; you can read one at a time and finish it cleanly.",
  "downloads.saveOffline.onlyOneVolume": "This novel only has one volume.",
  "downloads.saveOffline.volumesCountOne": "{n} volume",
  "downloads.saveOffline.volumesCountOther": "{n} volumes",
  "downloads.saveOffline.chaptersCountOne": "{n} chapter",
  "downloads.saveOffline.chaptersCountOther": "{n} chapters",
  "downloads.saveOffline.alreadyDownloaded": "{n} already downloaded",
  "downloads.saveOffline.volumesNotLoadedOne":
    "{n} volume not loaded — open the detail view first",
  "downloads.saveOffline.volumesNotLoadedOther":
    "{n} volumes not loaded — open the detail view first",

  // download queue view (Downloads dialog)
  "downloads.emptyState":
    'No downloads yet. Tap the download icon on any chapter to save it offline, or use "Save as offline book" from a novel\'s detail page to bake it into your library.',
  "downloads.sectionInterrupted": "Interrupted",
  "downloads.retryAll": "Retry all",
  "downloads.sectionSavingOffline": "Saving as offline book",
  "downloads.sectionDownloading": "Downloading chapters",
  "downloads.sectionRecent": "Recent",
  "downloads.cancelDownload": "Cancel download",
  "downloads.interruptedOne": "{n} interrupted",
  "downloads.interruptedOther": "{n} interrupted",
  "downloads.activeCountOne": "{n} in progress",
  "downloads.activeCountOther": "{n} in progress",
  "downloads.allCaughtUp": "All caught up",
  "downloads.clearCompleted": "Clear completed",
  "downloads.statusWaiting": "Waiting…",
  "downloads.statusSavedOne": "Saved {n} book",
  "downloads.statusSavedOther": "Saved {n} books",
  "downloads.statusDownloaded": "Downloaded",
  "downloads.statusFailed": "Failed: {error}",
  "downloads.unknownError": "unknown error",
  "downloads.statusCancelled": "Cancelled",
  "downloads.statusInterruptedPartialOne":
    "Interrupted — {n} book already saved",
  "downloads.statusInterruptedPartialOther":
    "Interrupted — {n} books already saved",
  "downloads.statusInterruptedResume": "Interrupted — tap Retry to resume",

  // store — sources list + a source's home (browse/search its homepage)
  "store.title": "Sources",
  "store.subtitle":
    "Browse novels from supported websites, then add them to your library or stream them inline.",
  "store.noSources": "No sources installed yet.",
  "store.filterWebsites": "Search websites…",
  "store.noMatchingWebsites": "No websites match “{query}”.",
  "store.backToSources": "Back to sources",
  "store.searchPlaceholder": "Search…",
  "store.searching": "Searching…",
  "store.loadSourceError": "Couldn't load this source — {error}",
  "store.noSections": "No sections found.",
  "store.itemsCountOne": "{n} item",
  "store.itemsCountOther": "{n} items",
  "store.resultsFor": "Results for “{query}”",
  "store.clear": "Clear",
  "store.searchFailed": "Search failed — {error}",
  "store.noResults": "No matches.",
  "store.loadMore": "Load more",
  "store.loadingMore": "Loading more…",
  "store.notInstalled": "Source “{sourceId}” isn't installed.",
  // Section carousel (SectionCarousel.tsx) arrow buttons on a source's home
  // page. "left"/"right" name the button's fixed physical position on
  // screen, not a scroll direction — the carousel already reverses the
  // underlying scroll math under RTL so the visible arrow always moves
  // content the way it looks like it should.
  "carousel.scrollStart": "Scroll back",
  "carousel.scrollEnd": "Scroll forward",

  // source — app-authored copy shipped with the bundled source extensions.
  // Card titles/descriptions now come from each site's own metadata (see
  // registry.ts), so only the fallback section headings live here — used on
  // the rare occasion a source's homepage doesn't yield one.
  "source.section.trendingFallback": "Trending",
  "source.section.hotUpdatesFallback": "Hot updates",

  // novel detail view (NovelDetailView.tsx) — action row, chapter search,
  // volumes accordion, per-chapter download button. The novel's own
  // scraped title/synopsis/author name/chapter+volume titles are NOT
  // here — those render as raw data. "novel.volumeFallback" backs the
  // "Volume N" placeholder title kolnovel-theme.ts/cenele.ts generate
  // when a source's own volume has no scraped label (surfaced in this
  // view + the downloads dialogs).
  "novel.loadError": "Couldn't load this novel — {error}",
  "novel.noDataReturned": "no data returned",
  "novel.noCover": "No cover",
  "novel.shelves": "Shelves",
  "novel.descMore": "more",
  "novel.descLess": "less",
  "novel.fromSource": "From {source}",
  "novel.read": "Read",
  "novel.addToLibrary": "Add to library",
  "novel.adding": "Adding…",
  "novel.removing": "Removing…",
  "novel.downloadRange": "Download range",
  "novel.removeConfirm":
    "Remove this novel from your library? Your downloaded chapter ranges (if any) are kept.",
  "novel.searchChaptersPlaceholder": "Search chapters…",
  "novel.clearChapterSearch": "Clear chapter search",
  "novel.searchingChapters": "Searching chapters…",
  "novel.searchChaptersError": "Couldn't search chapters — {error}",
  "novel.searchChaptersNoMatches": "No matches for “{query}”.",
  "novel.chaptersHeading": "Chapters",
  "novel.chapterCountShort": "{n} ch.",
  "novel.chaptersLoadError": "Couldn't load chapters — {error}",
  "novel.queuedClickCancel": "Queued — click to cancel",
  "novel.downloadingClickCancel": "Downloading ({pct}%) — click to cancel",
  "novel.downloadChapter": "Download chapter",
  "novel.downloadVolume": "Download volume",
  "novel.downloadVolumeConfirmTitle": "Download this volume?",
  "novel.downloadingVolume": "Queuing volume…",
  "novel.volumeAllDownloaded": "All chapters downloaded",
  "novel.volumeFallback": "Volume {n}",
  // Rare technical fallback (deferred from Task 10): a scraped chapter with
  // no usable title text after sanitization. Same rationale + pattern as
  // volumeFallback above — synthesized directly in the (non-React) source
  // parser via `makeTr(currentUiLocale())`, since it's a fallback DATA value
  // that gets persisted, not something rendered through a single display
  // site later.
  "novel.chapterNoTitleFallback": "{n} - No Title",

  // streaming reader (SourceStreamReader.tsx) — status/error chrome unique
  // to the source-backed streaming reader (novel load, chapter fetch). The
  // reader's own toolbar/back/prev/next/TOC/progress/settings chrome reuses
  // reader.* — DesktopReader/MobileReader render it directly and already
  // resolve it from the UI locale. Scraped chapter content, and the novel's
  // own title, are NOT here — they render as raw data.
  "stream.loadingNovel": "Loading novel…",
  "stream.noChapters": "This novel has no chapters.",
  "stream.loadErrorTitle": "Couldn't load this novel",
  "stream.loadingChapter": "Loading chapter…",
  "stream.chapterErrorTitle": "Couldn't load this chapter",
  "stream.backToNovel": "Back to novel",

  // docx manage-import view (DocxManageView.tsx) — the "manage before
  // importing" section manager for staged .docx conversions. The document's
  // OWN content (source filename, detected language code, section/heading
  // text, body preview, and unrecognized block-tag names) is DATA and is
  // NOT translated here — it renders raw / as interpolation params.
  // "RTL"/"LTR" and the H1–H6/IMG/P block-type codes are technical
  // structure notation (same rationale as "OLED"/"px" above) and stay
  // literal Latin abbreviations in both locales; only the spelled-out
  // block-type words (LIST/QUOTE/TABLE) are localized.

  // Native file-picker filter labels (Tauri's open() dialog — the "Files of
  // type" dropdown on Windows/Linux; the doc-import filter reuses
  // sidebar.wordDoc's identical text). Resolved via currentUiLocale() the
  // same way the source parsers do, since these store functions have no
  // React context.
  "picker.filterImage": "Image",

  // ── Task 13: user-facing error / status message sweep ──────────────────
  // Library.tsx toast bodies (dynamic parts — book/doc titles, counts, and
  // caught-error `.message` text — travel as interpolation params; see the
  // BOUNDARY note in the task brief).
  "status.emptyFolderImport":
    "That folder has no EPUB files at its top level — can't import an empty folder.",
  "status.importedFolderSkippedOne":
    "Imported {n} book, skipped {skipped} that couldn't be parsed.",
  "status.importedFolderSkippedOther":
    "Imported {n} books, skipped {skipped} that couldn't be parsed.",
  "status.importedFolderOne": "Imported {n} book.",
  "status.importedFolderOther": "Imported {n} books.",
  "status.coverNotFoundInEpub":
    "Couldn't find a cover in the original EPUB. Try “Set cover…” to pick an image yourself.",
  "status.alreadyInLibraryOne": "{n} already in your library.",
  "status.alreadyInLibraryOther": "{n} already in your library.",

  // Progress-phase labels. `job.phase` (download queue conversions) and
  // import `Step.label` (source + docx importers) are free-form English
  // strings set deep in non-React modules with no `tr` access — translated
  // at the DISPLAY site via `src/i18n/statusLabels.ts`'s `phaseLabel()`,
  // which maps the raw string to one of these keys (falling back to the
  // raw text for anything unrecognized). The producing modules keep
  // emitting the same fixed English text; treat it as a stable code.
  "status.phase.queued": "Queued",
  "status.phase.loadingSnapshot": "Loading snapshot",
  "status.phase.buildingEpub": "Building EPUB",
  "status.phase.savingToLibrary": "Saving to library",
  "status.phase.addingToLibrary": "Adding to library",
  "status.phase.readingFile": "Reading file",
  "status.phase.detectingLanguage": "Detecting language",
  "status.phase.convertingDocument": "Converting document",
  "status.phase.detectingChapters": "Detecting chapters",
  "status.phase.preparingPages": "Preparing pages",
  "status.phase.fetchingCover": "Fetching cover",
  "status.phase.fetchingChapters": "Fetching chapters",
  "status.phase.downloadingInlineImages": "Downloading inline images",
  "status.phase.loadingSourcePage": "Loading {source} page",
  "status.phase.fetchingChapterProgress": "Fetching chapter {n} / {total}",
  "status.phase.downloadingInlineImagesProgress":
    "Downloading inline images ({n}/{total})",
  "status.phase.loadingVolume": "Loading volume {n} / {total}: {title}",
  "status.phase.readingChapterProgress": "Reading chapter {n} / {total}",
  "status.phase.fetchingImageProgress": "Fetching image {n} / {total}",
  "status.phase.savedTitled": "Saved “{title}”",
  "status.phase.resumingVolume": "Resuming at volume {n} / {total}",
  "status.phase.buildingVolume": "Building volume {n} / {total}",
  "status.phase.savingVolume": "Saving volume {n}",
  "status.percentOnly": "{pct}%",
  "status.phaseWithPercent": "{phase} · {pct}%",

  // Stable, app-authored `Error.message` strings recognized by
  // `errorLabel()` (same file) at the display site (Library.tsx toasts,
  // DownloadQueueView's job.error, ImportProgress's state.error). Anything
  // NOT one of these stays raw — see BOUNDARY note.
  "error.anotherImportRunning": "Another import is already running",
  "error.unsupportedFile":
    "That file isn't an EPUB, PDF or DOCX — nothing to import.",
  "error.anotherImportInProgress": "Another import is still in progress.",
  "error.novelNoChaptersToConvert": "This novel has no chapters to convert.",
  "error.sourceNotInstalledBuild":
    "Source “{sourceId}” isn't installed in this build.",
  "error.sourceNotInstalledDownload":
    "Source “{sourceId}” isn't installed — can't download this chapter.",

  // System (OS-level) download notifications — src/store/downloadNotifier.ts
  // runs outside the component tree, so it resolves the UI locale the same
  // way kolnovel-theme.ts / cenele.ts already do (`document.documentElement.lang`)
  // and calls `makeTr()` directly rather than using `useI18n()`.
  // Android notification-channel metadata (registered once, lazily, on the
  // first permitted notification — see ensureChannel() in
  // downloadNotifier.ts). Resolved the same way as the rest of this file.
  "status.notif.reauthTitle": "Verification needed",
  "status.notif.reauthBody":
    "{host} needs its browser check completed again. Open the app and reopen the novel to continue downloading.",
  "status.notif.channelName": "Downloads",
  "status.notif.channelDescription":
    "Chapter downloads and offline-book conversions",
  "status.notif.convertingTitle": "Converting {novel}",
  "status.notif.percentDone": "{pct}% done",
  "status.notif.preparingOfflineBook": "Preparing offline book",
  "status.notif.jobsDoneOf": "{done} of {total} jobs done",
  "status.notif.downloadingChapterTitle": "Downloading {novel} — Ch. {n}",
  "status.notif.downloadingChaptersTitle": "Downloading chapters",
  "status.notif.backgroundWorkFinished": "Background work finished",
  "status.notif.completedCount": "{n} completed",
  "status.notif.failedCount": "{n} failed",
  "status.notif.cancelledCount": "{n} cancelled",
  "status.notif.allDone": "All done",
  "status.notif.jobsCompleteOne": "1 job complete",
  "status.notif.jobsCompleteOther": "{n} jobs complete",
  "status.notif.downloadingProgress": "Downloading {done} of {total} · {pct}%",
  "status.notif.importingTitle": "Importing book",
  "status.notif.importingBody": "{pct}% done",
  "status.notif.backgroundTasksTitle": "Background tasks · {pct}%",
  "status.notif.mixedBody": "{parts}",
  "status.notif.partDownloads": "Downloading {n}",
  "status.notif.partConverting": "Converting",
  "status.notif.partImporting": "Importing",
  "status.notif.chaptersDownloaded": "{n} chapters downloaded",
  "status.notif.downloadComplete": "Download complete",
  "status.notif.offlineBookReady": "Offline book ready",
  "status.notif.importComplete": "Import complete",
  "status.notif.allTasksDone": "All tasks complete",
  "status.notif.bookImported": "Book added to your library",
  "status.notif.importFailed": "Import failed",
  "status.notif.conversionFailed": "Offline book failed",

  // ContextMenu.tsx — status submenu labels reuse sidebar.reading/finished/
  // wishlist; these cover the menu's own remaining chrome.
  "contextMenu.status": "Status",
  "contextMenu.statusNone": "None",
  "contextMenu.editBookInfo": "Edit book info",
  "contextMenu.removeBook": "Remove book",
} as const;
