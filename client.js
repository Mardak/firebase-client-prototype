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
      this._sse = new EventSource(this.url + ".json?orderBy=\"$priority\"&limitToLast=2");
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

  _update(method, path, body) {
    if (method === "DELETE") {
      if (body !== null) {
        throw new Error("No body expected for .delete()");
      }
    } else if (! body || typeof body != "object") {
      throw new Error("JSON body expected");
    }
    let url = this._makeUrl(path);
    // Include the server timestamp in the special priority field on new records.
    body[".priority"] = { ".sv": "timestamp" };
    return this._request(method, url, JSON.stringify(body));
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

let baseUrl = 'https://blinding-fire-8842.firebaseio.com/client-test';

let client = new FirebaseClient(baseUrl);
client.on("put", write.bind(null, "->put"));
client.on("patch", write.bind(null, "->patch"));
client.on("close", write.bind(null, "(close)"));

function write() {
  let el = document.getElementById("output");
  let c = new Date().toLocaleTimeString() + ": ";
  for (let a of arguments) {
    if (! a || typeof a != "string") {
      a = JSON.stringify(a);
    }
    c += a + " ";
  }
  el.textContent = `${c}\n${el.textContent}`;
}

client.connect().then(() => {
  write("connected", client._sse.readyState);
});
