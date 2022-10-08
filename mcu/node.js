/*
    node-red-DS2482-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-ds2482-mcu
    License: MIT
*/

import { Node } from "nodered";
import { DS2482 } from "ds2482";
import I2C from "embedded:io/i2c";
import Timer from "timer";

class DS2482Node extends Node {

  #controller;
  #mode;
  #paths; // Array!

  static type = "ds2482";

  #timer;

  #status(fill, shape, text, timeout) {

    let self = this;

    fill ??= "";
    shape ??= "";
    timeout ??= 3000;

    if (!text) {
      self.status();
      return;
    }

    if (self.#timer) {
      Timer.clear(self.#timer);
      self.#timer = undefined;
    }

    self.status({ "fill": fill, "shape": shape, "text": text });
    self.#timer = Timer.set(function () {
      Timer.clear(self.#timer);
      self.#timer = undefined;
      self.status();
    }, timeout);
  }

  onStart(config) {
    super.onStart(config);

    this.#status("grey", "dot", "Idle");

    this.#mode = config.mode;
    this.#paths = config.paths;
    this.#controller = RED.nodes.getNode(config.controller);

  }

  onMessage(msg) {

    msg["ds2482"] ??= [];
    let log = msg["ds2482"];
    
    let self = this;

    function run(f) {
      try {
        return f();
      }
      catch (err) {
        trace.left(JSON.stringify({
          "error": {
            "error": err.message,
            "source": {
              "id": self.id,
              "type": self.constructor.type
            }
          }
        }));
      }
    }

    self.#status("blue", "dot", "Processing...", 5000);

    let path = msg?.topic?.length > 0 ? msg.topic : this.#paths;
    let ds = this.#controller.ds;

    // trace(msg.topic + "\n");
    // trace(this.#paths + "\n");

    if (this.#mode === "read") {

      let result;

      if (Array.isArray(path)) {
        result = [];
        path.forEach((p) => {
          let r = run(() => { return ds.readPath(p) });

          log.push({"path": p, "read": r})

          result.push(r)
        })
      } else {
        result = run(() => { return ds.readPath(path) });
        log.push({"path": path, "read": result})

      }

      msg.payload = result;

    } else if (this.#mode === "write") {

      if (Array.isArray(path)) {
        for (let i = 0; i < path.length; i++) {
          let v;
          if (Array.isArray(msg.payload)) {
            if (i < msg.payload.length) {
              v = msg.payload[i];
            }
          } else {
            v = msg.payload;
          }

          if (v) {
            log.push({"path": p, "write": v})
            run(() => { return ds.writePath(p, v) });
          }
        }
      } else {
        let v;
        if (Array.isArray(msg.payload) && msg.payload.length > 0) {
          v = msg.payload[0];
        } else {
          v = msg.payload;
        }
        if (v) {
          log.push({"path": p, "write": v})
          run(() => { return ds.writePath(p, v) });
        }
      }
    }

    this.#status("grey", "dot", "Idle");
    return msg;
  }

  onCommand(options) {
    let self = this;

    if ("search" === options.command) {
      let msg = {}
      msg.cmd = "search";
      self.#controller?.receive(msg);
    }

  }

  static {
    RED.nodes.registerType(this.type, this);
  }
}

class DS2482Controller extends Node {
  #ds;

  static type = "ds2482controller";

  run(f) {
    try {
      return f();
    }
    catch (err) {
      trace.left(JSON.stringify({
        "error": {
          "error": err.message,
          "source": {
            "id": this.id,
            "type": this.constructor.type
          }
        }
      }));
    }
  }

  onStart(config) {
    super.onStart(config);

    const options = {
      data: config.data,
      clock: config.clock,
      hz: config.hz,
      stop: true,
      timeout: 50,
      address: config.address
    };

    this.run(() => {
      let i2c = new I2C(options);
      this.#ds = new DS2482(i2c);
      this.#ds.configureBridge({
        activePullup: true
      })
    })
  }

  onMessage(msg) {
    if (msg?.cmd == "search") {

      let self = this;

      let res = self.run(() => {
        return self.#ds.paths;
      })

      if (res) {
        // Feed back to the editor.
        trace.left(JSON.stringify({
          input: {
            cmd: "path_update",
            stamp: Math.round(Date.now() / 1000),
            paths: res,
            source: {
              id: self.id,
              type: self.constructor.type,
              name: self.name
            }
          }
        }));
      }
    }
  }

  get ds() {
    return this.#ds;
  }

  static {
    RED.nodes.registerType(this.type, this);
  }

}