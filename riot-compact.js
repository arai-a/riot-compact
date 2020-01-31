function sleep(t) {
  return new Promise(r => setTimeout(r, t));
}

async function waitForClassName(name) {
  for (let i = 0; i < 20; i++) {
    const elems = document.getElementsByClassName(name);
    if (elems.length > 0) {
      return elems[0];
    }
    await sleep(500);
  }
  return null;
}

// Task that can be run multiple times, but subsequent run within `timeout`
// is folded into single run, after `timeout` from the previous run.
//
//     run()  run()  run()                   run()
//       |      |      |                       |
//       v      v      v                       v
// ------+---------------+---------------+-----+------> t
//       |    timeout    |    timeout    |     |
//       |<------------->|<------------->|     |
//       |               |                     |
//       v               v                     v
//      f()             f()                   f()
//
class Task {
  constructor(f, timeout) {
    this.f = f;
    this.timeout = timeout;
    this.timer = null;
    this.lastTime = 0;
  }

  run() {
    if (this.timer) {
      return;
    }

    const now = Date.now();
    if (now < this.lastTime + this.timeout) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.lastTime = Date.now();

        const f = this.f;
        f().catch(e => console.error(e));
      }, this.timeout);
      return;
    }

    this.lastTime = now;
    const f = this.f;
    f().catch(e => console.error(e));
  }
}

// Class to track observers for adding childNode to given node.
class AddedNodeObservers {
  constructor() {
    this.observers = [];
  }

  // Add observer to `node`.
  // When childNode is added to `node`, `callback` is called.
  add(node, callback) {
    const obs = new MutationObserver(mutationsList => {
      if (this._hasAddedNodes(mutationsList)) {
        callback().catch(e => console.error(e));
      }
    });
    this.observers.push(obs);

    obs.observe(node, {
      childList: true,
    });
  }

  // Disconnect all observers.
  disconnectAll() {
    for (const obs of this.observers) {
      try {
        obs.disconnect();
      } catch (e) {
      }
    }
    this.observers = [];
  }

  _hasAddedNodes(mutationsList) {
    for (const item of mutationsList) {
      if (item.addedNodes.length) {
        return true;
      }
    }
    return false;
  }
}

// Set document.body class for light/dark theme, to use from CSS.
class ThemeToClass {
  constructor() {
    this.links = [];
    this.observer = null;
  }

  async apply() {
    // Wait for some random element to wait for link elements.
    await waitForClassName("mx_MatrixChat");

    this.collectLinks();
    this.hookThemeChange();
    this.updateTheme();
  }

  // Collect link elements for light/dark stylesheets.
  collectLinks() {
    for (const link of document.getElementsByTagName("link")) {
      if (link.getAttribute("rel") !== "stylesheet") {
        continue;
      }

      const title = link.getAttribute("title");
      if (!title) {
        continue;
      }

      const isLight = title.startsWith("Light");
      const isDark = title.startsWith("Dark");
      if (isLight || isDark) {
        this.links.push({ node: link, isLight });
      }
    }
  }

  // When theme is changed, "disabled" attribute of link elements gets changed.
  // Hook it and update class.
  hookThemeChange() {
    this.observer = new MutationObserver(() => {
      this.updateTheme();
    });

    for (const link of this.links) {
      this.observer.observe(link.node, {
        attributes: true,
      });
    }
  }

  // Set document.body class for light/dark theme.
  updateTheme() {
    if (this.isLightTheme()) {
      document.body.classList.remove("ext-body-dark");
      document.body.classList.add("ext-body-light");
    } else {
      document.body.classList.remove("ext-body-light");
      document.body.classList.add("ext-body-dark");
    }
  }

  isLightTheme() {
    for (const link of this.links) {
      if (link.node.hasAttribute("disabled")) {
        continue;
      }
      return link.isLight;
    }
  }
}

class TimelineModifier {
  constructor() {
    // The list element for timeline.
    this.list = null;

    // The map from item's token to `odd` flag.
    //
    // The entry of this map increases whenever noteOddEven is called,
    // but this will be cleared whenever switching room, so this won't make much
    // trouble.
    this.oddEvenMap = {};

    this.observers = new AddedNodeObservers();

    this.newTimelineItemTask = new Task(async () => {
      this.modifyTimeline(false);
    }, 500);

    this.roomSwitchTask = new Task(async () => {
      this.oddEvenMap = {};
      this.observers.disconnectAll();
      await this.update(false);
    }, 500);

    this.timelineReconstructTask = new Task(async () => {
      this.observers.disconnectAll();
      await this.update(false);
    }, 500);
  }

  async apply() {
    await this.update(true);
  }

  async update(isFirst) {
    this.list = await waitForClassName("mx_RoomView_MessageList");
    this.modifyTimeline(isFirst);

    this.hookNewTimelineItem();
    await this.hookRoomSwitch();
    await this.hookTimelineReconstruct();
  }

  // ==== Hook modification to timeline DOM  ====

  // Hook new timeline item events, including new message, scroll up and down.
  hookNewTimelineItem() {
    this.observers.add(this.list, async () => {
      this.newTimelineItemTask.run();
    });
  }

  // Hook room switch that replaces timeline node.
  async hookRoomSwitch() {
    const node = await waitForClassName("mx_MatrixChat");
    this.observers.add(node, async () => {
      if (!await this.isListAlive()) {
        this.roomSwitchTask.run();
      }
    });
  }

  // Hook the reconstruction of timeline and update the internal references etc.
  // In several events (scroll, opening sidebar, etc), timeline gets replaced,
  // and the root node differs for each case.
  async hookTimelineReconstruct() {
    for (let node = this.list;
         node && !node.classList.contains("mx_MatrixChat");
         node = node.parentNode) {
      this.observers.add(node, async () => {
        if (!await this.isListAlive()) {
          this.timelineReconstructTask.run();
        }
      });
    }
  }

  // Returns whether the `this.list` points the current list on the page.
  // This gets false when the timeline gets replaced.
  async isListAlive() {
    const currentList = await waitForClassName("mx_RoomView_MessageList");
    return this.list === currentList;
  }

  // ==== Timeline modification ====

  modifyTimeline(isFirst) {
    this.addDate();
    this.colorTimeline(isFirst);
  }

  // Add month/date to timestamp.
  addDate() {
    function pad2(n) {
      return n.toString().padStart(2, "0");
    }

    // Apply to all timestamps, including items inside summary (a summary can
    // contain mutliple timestamps).
    const timestamps = this.list.getElementsByClassName("mx_MessageTimestamp");
    for (const timestamp of timestamps) {
      const date = new Date(timestamp.getAttribute("title"));
      const prefix = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} `;
      timestamp.setAttribute("ext-date", prefix);
    }
  }

  // Apply alternating line coloring.
  colorTimeline(isFirst) {
    const items = this.collectItems();
    const firstItemIsOdd = isFirst ? false : this.isFirstItemOdd(items);
    this.noteOddEven(firstItemIsOdd, items);
    this.setClass(firstItemIsOdd, items);
  }

  // Returns items for alternating line coloring.
  collectItems() {
    const items = [];
    for (const item of this.list.childNodes) {
      const nodeName = item.nodeName.toLowerCase();
      if (nodeName === "li") {
        if (item.classList.contains("mx_RoomView_myReadMarker_container")) {
          // Marker for new message.
          continue;
        }

        // Message or separator for "Today" etc.
      } else if (nodeName === "div") {
        if (!item.classList.contains("mx_EventListSummary")) {
          // Typing notification.
          continue;
        }

        // Event summary (joined, changed name, etc).
        // This can contain multiple "li", but given it's expandable,
        // apply single color to the entire summary.
      } else {
        continue;
      }

      // Message contains token.
      const token = item.getAttribute("data-scroll-tokens");

      items.push({ node: item, token });
    }

    return items;
  }

  // Calculate the `odd` flag for the first line, after items inside the
  // timeline are modified.
  isFirstItemOdd(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.token in this.oddEvenMap) {
        return this.oddEvenMap[item.token]
          ? !(i % 2)
          : !!(i % 2);
      }
    }

    return false;
  }

  // Set class for alternating line coloring, used by CSS.
  setClass(odd, items) {
    for (const item of items) {
      // Basically this shouldn't be necessary, unless the coloring gets
      // *flipped*.
      item.node.classList.remove(odd ? "ext-line-even" : "ext-line-odd");

      item.node.classList.add(odd ? "ext-line-odd" : "ext-line-even");
      odd = !odd;
    }
  }

  // Note the current `odd` flag of some items, to keep coloring not *flipped*
  // when new items are added to timeline.
  // The data is use by isFirstItemOdd.
  noteOddEven(firstItemIsOdd, items) {
    const noteOne = (index, token) => {
      const odd = firstItemIsOdd
            ? !(index % 2)
            : !!(index % 2);
      this.oddEvenMap[token] = odd;
    };

    // Note the first one with token.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.token) {
        noteOne(i, item.token);
        break;
      }
    }

    // Note the last one with token.
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.token) {
        noteOne(i, item.token);
        break;
      }
    }
  }
}

async function onLoad() {
  const themeToClass = new ThemeToClass();
  await themeToClass.apply();

  const modifier = new TimelineModifier();
  await modifier.apply();
}

onLoad().catch(e => console.error(e));
