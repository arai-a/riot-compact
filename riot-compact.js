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

function hasAddedNodes(mutationsList) {
  for (const item of mutationsList) {
    if (item.addedNodes.length) {
      return true;
    }
  }
  return false;
}

function getItems(list) {
  const items = [];
  for (const item of list.childNodes) {
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

function noteOddEven(firstItemIsOdd, items, oddEvenMap) {
  function note(index, token) {
    const odd = firstItemIsOdd
          ? !(index % 2)
          : !!(index % 2);
    oddEvenMap[token] = odd;
  }

  // Note the first one with token.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.token) {
      note(i, item.token);
      break;
    }
  }

  // Note the last one with token.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.token) {
      note(i, item.token);
      break;
    }
  }
}

function setClass(odd, items) {
  for (const item of items) {
    item.node.classList.remove(odd ? "ext-line-even" : "ext-line-odd");
    item.node.classList.add(odd ? "ext-line-odd" : "ext-line-even");
    odd = !odd;
  }
}

function getFirstItemIsOdd(items, oddEvenMap) {
  let firstItemIsOdd = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.token in oddEvenMap) {
      firstItemIsOdd = oddEvenMap[item.token]
        ? !(i % 2)
        : !!(i % 2);
      break;
    }
  }
  return firstItemIsOdd;
}

let existingObservers = [];

async function onRoomChange() {
  // Map from item's token to `odd` flag.
  //
  // The entry of this map increases whenever colorTimeline is called,
  // but this will be released whenever switching room, so this won't make much
  // trouble.
  const oddEvenMap = {};

  let list = await waitForClassName("mx_RoomView_MessageList");
  if (!list) {
    return;
  }

  const updateTask = new Task(() => {
    colorTimeline(false);
  }, 500);

  function hookTimelineModification() {
    const observer = new MutationObserver(mutationsList => {
      if (hasAddedNodes(mutationsList)) {
        updateTask.run();
      }
    });
    existingObservers.push(observer);

    observer.observe(list, {
      childList: true,
    });
  }

  function disconnectObservers() {
    for (const obs of existingObservers) {
      try {
        obs.disconnect();
      } catch (e) {
      }
    }
    existingObservers = [];
  }

  function colorTimeline(first) {
    const items = getItems(list);
    const firstItemIsOdd = first ? false : getFirstItemIsOdd(items, oddEvenMap);
    noteOddEven(firstItemIsOdd, items, oddEvenMap);
    setClass(firstItemIsOdd, items);
  }

  async function checkListAlive(task) {
    const currentList = await waitForClassName("mx_RoomView_MessageList");
    if (list != currentList) {
      task.run();
    }
  }

  const roomSwitchTask = new Task(async () => {
    await onRoomChange();
  }, 500);

  async function hookRoomSwitch() {
    // When switching room, all nodes gets replaced.

    const observer = new MutationObserver(mutationsList => {
      if (hasAddedNodes(mutationsList)) {
        checkListAlive(roomSwitchTask).catch(e => console.error(e));
      }
    });
    existingObservers.push(observer);

    const node = await waitForClassName("mx_MatrixChat");
    observer.observe(node, {
      childList: true,
    });
  }

  async function onTimelineReconstruct(first) {
    if (!first) {
      list = await waitForClassName("mx_RoomView_MessageList");
    }

    disconnectObservers();
    hookTimelineModification();
    colorTimeline(first);
    await hookRoomSwitch();
    await hookTimelineReconstruct();
  }

  const timelineReconstructTask = new Task(async () => {
    await onTimelineReconstruct(false);
  }, 500);

  async function hookTimelineReconstruct() {
    // In some case (maybe on scroll down), timeline content gets replaced.

    const observer = new MutationObserver(mutationsList => {
      if (hasAddedNodes(mutationsList)) {
        checkListAlive(timelineReconstructTask).catch(e => console.error(e));
      }
    });
    existingObservers.push(observer);

    const node = await waitForClassName("mx_RoomView_timeline");
    observer.observe(node, {
      childList: true,
    });
  }

  await onTimelineReconstruct(true);
}

async function onLoad() {
  await onRoomChange();
}

onLoad().catch(e => console.error(e));
