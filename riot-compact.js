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
// is folded into single run, after `timeout`.
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

class AddedNodeObservers {
  constructor() {
    this.observers = [];
  }

  add(node, callback) {
    const obs = new MutationObserver(mutationsList => {
      if (this.hasAddedNodes(mutationsList)) {
        callback().catch(e => console.error(e));
      }
    });
    this.observers.push(obs);

    obs.observe(node, {
      childList: true,
    });
  }

  disconnectAll() {
    for (const obs of this.observers) {
      try {
        obs.disconnect();
      } catch (e) {
      }
    }
    this.observers = [];
  }

  hasAddedNodes(mutationsList) {
    for (const item of mutationsList) {
      if (item.addedNodes.length) {
        return true;
      }
    }
    return false;
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

    this.updateTask = new Task(async () => {
      this.modifyTimeline(false);
    }, 500);

    this.roomSwitchTask = new Task(async () => {
      this.clearOddEvenMap();
      this.observers.disconnectAll();
      await this.update(false);
    }, 500);

    this.timelineReconstructTask = new Task(async () => {
      this.observers.disconnectAll();
      await this.update(false);
    }, 500);
  }

  async run() {
    await this.hookStyleChange();
    await this.update(true);
  }

  async update(isFirst) {
    this.list = await waitForClassName("mx_RoomView_MessageList");
    this.modifyTimeline(isFirst);

    this.hookTimelineModification();
    await this.hookRoomSwitch();
    await this.hookTimelineReconstruct();
  }

  // ==== Hook light/dark  ====

  async hookStyleChange() {
    // Wait for some random element to wait for link elements.
    await waitForClassName("mx_MatrixChat");

    const links = [];
    function updateTheme() {
      for (const link of links) {
        if (link.node.hasAttribute("disabled")) {
          continue;
        }

        if (link.isLight) {
          document.body.classList.remove("ext-body-dark");
          document.body.classList.add("ext-body-light");
        } else {
          document.body.classList.remove("ext-body-light");
          document.body.classList.add("ext-body-dark");
        }
        break;
      }
    }

    const obs = new MutationObserver(updateTheme);

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
        links.push({ node: link, isLight });
        obs.observe(link, {
          attributes: true,
        });
      }
    }

    updateTheme();
  }

  // ==== Hook modification to timeline DOM  ====

  hookTimelineModification() {
    this.observers.add(this.list, async () => {
      this.updateTask.run();
    });
  }

  async hookRoomSwitch() {
    // When switching room, all nodes gets replaced.
    const node = await waitForClassName("mx_MatrixChat");
    this.observers.add(node, async () => {
      if (!await this.isListAlive()) {
        this.roomSwitchTask.run();
      }
    });
  }

  async hookTimelineReconstruct() {
    // In some case (maybe on scroll down), timeline content gets replaced.
    const node = await waitForClassName("mx_RoomView_timeline");
    this.observers.add(node, async () => {
      if (!await this.isListAlive()) {
        this.timelineReconstructTask.run();
      }
    });
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

  addDate() {
    function pad2(n) {
      return n.toString().padStart(2, "0");
    }

    const timestamps = this.list.getElementsByClassName("mx_MessageTimestamp");
    for (const timestamp of timestamps) {
      const date = new Date(timestamp.getAttribute("title"));
      const prefix = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} `;
      timestamp.setAttribute("ext-date", prefix);
    }
  }

  colorTimeline(isFirst) {
    const items = this.getItems();
    const firstItemIsOdd = isFirst ? false : this.isFirstItemOdd(items);
    this.noteOddEven(firstItemIsOdd, items);
    this.setClass(firstItemIsOdd, items);
  }

  getItems() {
    const items = [];
    for (const item of this.list.childNodes) {
      const nodeName = item.nodeName.toLowerCase();
      if (nodeName === "li") {
        if (item.classList.contains("mx_RoomView_myReadMarker_container")) {
          continue;
        }
      } else if (nodeName === "div") {
        if (!item.classList.contains("mx_EventListSummary")) {
          continue;
        }
      } else {
        continue;
      }

      const token = item.getAttribute("data-scroll-tokens");
      items.push({ node: item, token });
    }
    return items;
  }

  isFirstItemOdd(items) {
    let firstItemIsOdd = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.token in this.oddEvenMap) {
        firstItemIsOdd = this.oddEvenMap[item.token]
          ? !(i % 2)
          : !!(i % 2);
        break;
      }
    }
    return firstItemIsOdd;
  }

  setClass(odd, items) {
    for (const item of items) {
      item.node.classList.remove(odd ? "ext-line-even" : "ext-line-odd");
      item.node.classList.add(odd ? "ext-line-odd" : "ext-line-even");
      odd = !odd;
    }
  }

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

  clearOddEvenMap() {
    this.oddEvenMap = {};
  }
}

async function onLoad() {
  const modifier = new TimelineModifier();
  modifier.run().catch(e => console.error(e));
}

onLoad().catch(e => console.error(e));
