class FirebaseClient {
  constructor(url) {
    this.url = url.replace(/\/*$/, "");
    this._sse = null;
    this._handlers = {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this._sse) {
        console.warn("Reconnecting with open event stream");
        this.close("reconnect");
      }
      // Fetch only newest records to avoid fetching everything.
      this._sse = new EventSource(this.url + ".json?orderBy=\"timestamp\"&limitToLast=1");
      for (let eventName of this.EVENTS) {
        this._sse.addEventListener(eventName, this._onEvent.bind(this, eventName));
      }
      this._sse.addEventListener("cancel", this._onRemoteClose.bind(this, "cancel"));
      this._sse.addEventListener("auth_revoked", this._onRemoteClose.bind(this, "auth_revoked"));
      this._sse.addEventListener("close", this._onClose.bind(this));
      let resolved = false;
      this._sse.onerror = (error) => {
        if (! resolved) {
          reject(error);
          return;
        }
        this.emit("error", error);
      };
      this._sse.onopen = () => {
        resolved = true;
        resolve();
      };
    });
  }

  close(reason) {
    if (! this._sse) {
      console.warn("Attempt to close event stream that isn't open");
      return;
    }
    this._sse.close();
    this._sse = null;
    this.emit("close", {reason});
  }

  _onClose(event) {
    console.warn("Event stream unexpectedly closed:", event);
    this.emit("close", {reason: "reset", event});
    // FIXME: could conflict with a reconnect/reopen (could null out a different connection than the one that closed)
    //this._sse = null;
  }

  _onRemoteClose(reason, event) {
    console.warn("Event stream closed by remote because:", reason);
    this.close(reason);
  }

  _onEvent(eventName, event) {
    this.emit(eventName, JSON.parse(event.data));
  }

  _makeUrl(path) {
    if (Array.isArray(path)) {
      path = path.join("/");
    }
    path = path.replace(/^\/*/, "").replace(/\/*$/, "");
    return this.url + "/" + path + ".json";
  }

  get(path, query) {
    let url = this._makeUrl(path);
    return this._request("GET", `${url}?${query}`);
  }

  put(path, body) {
    return this._update("PUT", path, body);
  }

  patch(path, body) {
    return this._update("PATCH", path, body);
  }

  post(path, body) {
    return this._update("POST", path, body);
  }

  delete(path) {
    return this._update("DELETE", path, null);
  }

  _update(method, path, value) {
    if (method === "DELETE") {
      if (value !== null) {
        throw new Error("No value expected for .delete()");
      }
    }
    let url = this._makeUrl(path);
    return this._request(method, url, JSON.stringify({
      timestamp: { ".sv": "timestamp" },
      value
    }));
  }

  _request(method, url, body) {
    return new Promise(function (resolve, reject) {
      let req = new XMLHttpRequest();
      req.open(method, url);
      req.onload = function () {
        if (req.status != 200) {
          reject({request: req, name: "REQUEST_ERROR"});
        } else {
          let body = JSON.parse(req.responseText);
          resolve(body);
        }
      };
      req.send(body || null);
    });
  }

  on(eventName, callback) {
    if (eventName in this._handlers) {
      this._handlers[eventName].push(callback);
    } else {
      this._handlers[eventName] = [callback];
    }
  }

  off(eventName, callback) {
    let l = this._handlers[eventName] || [];
    if (l.includes(callback)) {
      l.splice(l.indexOf(callback), 1);
    }
  }

  emit(eventName, argument) {
    for (let callback of this._handlers[eventName] || []) {
      callback(argument);
    }
  }
}

FirebaseClient.prototype.EVENTS = ['put', 'patch'];


/**********************************************************
 * sample code
 */

let baseUrl = 'https://blinding-fire-8842.firebaseio.com/client-test2';

let client = new FirebaseClient(baseUrl);
client.on("put", write.bind(null, "->put"));
client.on("patch", write.bind(null, "->patch"));
client.on("close", write.bind(null, "(close)"));

function write() {
  let el = document.getElementById("output");
  let c = new Date().toLocaleTimeString() + ": ";
  let args = Array.prototype.slice.call(arguments);
  for (let a of args) {
    if (! a || typeof a != "string") {
      a = JSON.stringify(a);
    }
    c += a + " ";
  }
  el.textContent = `${c}\n${el.textContent}`;
}


class LoopFirebaseServer {
  constructor(url) {
    this._client = client;
    this._clockSkew = 0;
    this._live = false;
    this._handlers = {};

    this.update("meta", "lastConnect").then(({ timestamp }) => {
      this._clockSkew = timestamp - Date.now();
    });

    this._client.connect().then(() => {
      write("connected", this._client._sse.readyState);
      this._live = true;
      this._emit("connect");
    });

    this._client.on("put", ({ data, path }) => {
      // Ignore initial put from connecting.
      if (path === "/") {
        return;
      }

      // Remove the leading "/" from the path.
      let key = path.slice(1);
      this._emit("update", this._formatRecord(key, data));
    });
  }

  /**
   * Get the maximum query limit value: 2^31 - 1.
   */
  get MAX_LIMIT() {
    return 2147483647;
  }

  /**
   * Convert an object with key/value pairs into a query string.
   */
  _buildQuery(object) {
    return Object.keys(object).map(key => `${key}=${object[key]}`).join("&");
  }

  /**
   * Format a single record splitting out the type and id.
   */
  _formatRecord(key, record) {
    let [, type, id] = key.match(/^([^!]+)!(.+)$/);
    return Object.assign(record, { id, type });
  }

  /**
   * Get a callback that formats multiple records.
   */
  get _recordsFormatter() {
    return records => {
      if (records == null) {
        return [];
      }
      return Object.keys(records).map(key => this._formatRecord(key, records[key]));
    };
  }

  requestRoomData() {
    // Get all records with keys after "chat".
    let query = this._buildQuery({
      orderBy: `"$key"`,
      startAt: `"chat~"`,
      // Always have a limit to get things sorted correctly.
      limitToLast: this.MAX_LIMIT
    });
    return this._client.get("", query).then(this._recordsFormatter).then(records => {
      // Put participants first.
      return records.sort((a, b) => {
        return b.type === "participant";
      });
    });
  }

  requestChat(startTime = 0, endTime = this.getServerTime(), limit = 0) {
    let query = this._buildQuery({
      format: "export",
      orderBy: `"$key"`,
      // Fudge the time a little to get an inclusive range with the random parts.
      startAt: `"chat!${this.makeId(Math.max(0, startTime - 1))}"`,
      endAt: `"chat!${this.makeId(endTime + 1)}"`,
      // Always have a limit to get things sorted correctly.
      limitToLast: limit > 0 ? limit : this.MAX_LIMIT
    });
    return this._client.get("", query).then(this._recordsFormatter);
  }

  /**
   * Generate an id based on the time.
   * https://gist.github.com/mikelehen/3596a30bd69384624c11
   */
  makeId(time = Date.now()) {
    if (this.makeId.CHARS === undefined) {
      Object.assign(this.makeId, {
        CHARS: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~",
        lastRandChars: [],
        lastTime: 0
      });
    }

    let duplicateTime = time === this.makeId.lastTime;
    this.makeId.lastTime = time;

    let timeStampChars = [];
    for (let i = 7; i >= 0; i--) {
      timeStampChars.unshift(this.makeId.CHARS.charAt(time % 64));
      time = Math.floor(time / 64);
    }
    if (time !== 0) {
      throw new Error("We should have converted the entire timestamp.");
    }

    let id = timeStampChars.join("");
    if (duplicateTime) {
      let i = 11;
      for (; i >= 0 && this.makeId.lastRandChars[i] === 63; i--) {
        this.makeId.lastRandChars[i] = 0;
      }
      this.makeId.lastRandChars[i]++;
    }
    else {
      for (let i = 0; i < 12; i++) {
        this.makeId.lastRandChars[i] = Math.floor(Math.random() * 64);
      }
    }
    for (let i = 0; i < 12; i++) {
      id += this.makeId.CHARS.charAt(this.makeId.lastRandChars[i]);
    }
    if (id.length !== 20) {
      throw new Error("Length should be 20.");
    }

    return id;
  }

  /**
   * Get the server time for a local time or now.
   */
  getServerTime(time = Date.now()) {
    return this._clockSkew + time;
  }

  get live() {
    return this._live;
  }

  update(type, id, value) {
    let key = `${type}!${id}`;
    return this._client.put(key, value).then(result => {
      return this._formatRecord(key, result);
    });
  }

  delete(type, id) {
    return this.update(type, id);
  }

  on(eventName, callback) {
    if (eventName in this._handlers) {
      this._handlers[eventName].push(callback);
    } else {
      this._handlers[eventName] = [callback];
    }
  }

  off(eventName, callback) {
    let l = this._handlers[eventName] || [];
    if (l.includes(callback)) {
      l.splice(l.indexOf(callback), 1);
    }
  }

  _emit(eventName, argument) {
    for (let callback of this._handlers[eventName] || []) {
      callback(argument);
    }
  }
}
