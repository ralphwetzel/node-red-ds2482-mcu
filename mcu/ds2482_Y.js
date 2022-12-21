/*
    This code is based on DS2482 Onewire Bridge
    Copyright (c) 2017 Ian Metcalf
    https://github.com/ianmetcalf/node-ds2482
    License: MIT

    Adaptations to node-red-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-ds2482-mcu
    License: MIT
*/

'use strict';

import Modules from "modules";
import Timer from "timer";

// https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/tools/manifest.md#config
import config_from_manifest from "mc/config";

import { cmds } from "commands";
// import { Buffer } from "buffer";
import { CRC8, CRC16 } from "crc";
import Hex from "hex";

// const utils = require('./utils');

// trace = function() {};

const ROM_SIZE = 8;

// const _utils = {
//     checkCRC: function (buffer, length) {

//         if (!(buffer instanceof Buffer)) {
//             // eslint-disable-next-line no-param-reassign
//             buffer = Buffer.from(Array.isArray(buffer) ? buffer : [buffer]);
//         }

//         length = length ?? buffer.length;

//         let crc = 0;

//         for (let i = 0; i < length; i += 1) {
//             crc ^= buffer[i];

//             for (let j = 0; j < 8; j += 1) {
//                 if (crc & 0x01) {
//                     crc = (crc >> 1) ^ 0x8C;
//                 } else {
//                     crc >>= 1;
//                 }
//             }
//         }

//         return (crc === 0);
//     },

//     // delay: function (duration) {
//     //     return new Promise(resolve => {
//     //         setTimeout(() => {
//     //             trace(duration + "\n");
//     //             resolve();
//     //         }, duration)
//     //     })
//     // }
// }

// const utils = Object.freeze(_utils);

// const owFamilyCode = {
//     "26": "ds2438"
// }

// The generic (= not implemented) 1-wire device
class owGeneric {
    paths = { "not_implemented": [] }
}

// class owDevice {

//     #id;
//     #paths = {};

//     add_path(name, read, write) {
//         if (name in this.#paths) {
//             throw new RangeError(`Path labeled "${name}" already exists.`)
//         }
//         this.#paths[name] = [read, write];
//     }

//     constructor(id) {
//         this.#id = id;
//     }

//     get id() {
//         return this.#id;
//     }

//     read(bridge, id, path) {
//         if (path in this.#paths) {
//             return this.#paths[path][0](bridge, id);
//         }
//     }

//     write(bridge, id, path, data) {
//         if (path in this.#paths) {
//             this.#paths[path][1](bridge, id, data);
//             return true;
//         }
//         return;
//     }

//     get paths() {
//         return Object.keys(this.#paths).sort();
//     }
// }


// class ds2438 extends owDevice {

//     static {
//         super.#add("temperature", function(bridge, id, path){}, function(bridge, id, path, data){})

//     }



// }




class DS2482_X {

    /* the table to translate family codes to module names shall be defined in the
     * manifest.json:
     *  {
     *      config: {
     *          ds2482: {
     *              <family_code>: <module_name>
     *          }
     *      }
     *  }
     */
    #modules4devices = config_from_manifest?.ds2482?.devices;
    #modules = {};

    #devices = [];
    #workers = {};

    constructor(i2c) {
        // eslint-disable-next-line no-param-reassign
        // options = options || {};

        this.i2c = i2c;
        this.channel = null;
    }

    /*
     * Main API
     */

    init() {
        return this.reset();
    }

    reset() {
        this.lastFound = null;
        this.lastConflict = 0;

        this._resetBridge();
        return this._resetWire();
    }

    configureBridge(options, confirm) {
        // let config = 0;

        options ??= {};

        this._wait(true);
        this._i2cWrite([cmds.SET_READ_POINTER, cmds.REGISTERS.CONFIG]);
        let config = this._i2cRead() & 0x0F;

        if (options.activePullup) {
            config = (config & ~cmds.CONFIG.ACTIVE) | ((options.activePullup ? 1 : 0) * cmds.CONFIG.ACTIVE)
        }
        if (options.strongPullup) {
            config = (config & ~cmds.CONFIG.STRONG) | ((options.strongPullup ? 1 : 0) * cmds.CONFIG.STRONG)
        }
        if (options.overdrive) {
            config = (config & ~cmds.CONFIG.OVERDRIVE) | ((options.overdrive ? 1 : 0) * cmds.CONFIG.OVERDRIVE)
        }

        this._i2cWrite([cmds.WRITE_CONFIG, ((~config & 0x0F) << 4) | config]);

        let resp;
        if (confirm) {
            resp = this._readBridge();
            if (config !== resp) {
                throw new Error('Failed to configure bridge');
            }
        }

        return resp;
    }

    strongPullup() {
        this.configureBridge({ strongPullup: true });
    }

    selectChannel(num) {

        const ch = cmds.SELECTION_CODES[num || 0];
        if (!ch) {
            throw new Error('Invalid channel');
        }

        if (this.channel === num) {
            return ch.read;
        }

        this._wait(true);
        this.writeData(cmds.CHANNEL_SELECT, [ch.write]);
        let resp = this._readBridge();

        if (ch.read !== resp) {
            throw new Error('Failed to select channel');
        }

        this.channel = num;
        return resp;
    }

    sendCommand(cmd, rom) {
        rom ? this.matchROM(rom) : this.skipROM();
        this.writeData(cmd);
    }

    search() {
        this.lastFound = null;
        this.lastConflict = 0;

        const found = [];

        const searchNext = () => {
            let resp = this.searchROM();
            found.push(resp);

            if (this.lastConflict) {
                return searchNext();
            }

            this.lastFound = null;
            this.lastConflict = 0;

            return found;
        };

        return searchNext();
    }

    searchByFamily(family) {
        if (typeof family === 'string') {
            // eslint-disable-next-line no-param-reassign
            family = parseInt(family, 16);
        }

        this.lastFound = Uint8Array.of(family, 0, 0, 0, 0, 0, 0, 0);
        this.lastConflict = 64;

        const found = [];

        const searchNext = () => {
            let resp = this.searchROM()

            if (this.lastFound[0] === family) {
                found.push(resp);
            }

            if (this.lastConflict > 7 && found.length) {
                return searchNext();
            }

            this.lastFound = null;
            this.lastConflict = 0;

            return found;
        };

        return searchNext();
    }

    /*
     * Onewire ROM API
     */

    searchROM() {
        const rom = new Uint8Array(ROM_SIZE);

        let offset = 0;
        let mask = 0x01;
        let bit = 1;
        let lastConflict = 0;

        const direction = () => {
            if (this.lastFound && bit < this.lastConflict) {
                return this.lastFound[offset] & mask;
            }

            return bit === this.lastConflict ? 1 : 0;
        };

        const searchNextBit = () => {
            let d = direction();
            // trace("dir: " + d + "\n");

            let resp = this.triplet(d);

            const sbr = (resp & cmds.STATUS.SINGLE_BIT);
            const tsb = (resp & cmds.STATUS.TRIPLE_BIT);
            const dir = (resp & cmds.STATUS.BRANCH_DIR);

            // trace(resp + "\n");

            if (sbr && tsb) {
                throw new Error('Bad search result');
            }

            if (!sbr && !tsb && !dir) {
                lastConflict = bit;
            }

            const part = rom[offset];

            rom[offset] = dir ? part | mask : part & ~mask;

            mask <<= 1;
            bit += 1;

            if (mask > 128) {
                offset += 1;
                mask = 0x01;
            }

            if (offset < rom.length) {
                return searchNextBit();
            }

            if (rom[0] === 0) {
                throw new Error('ROM invalid');
            }

            if (this.crc8(rom) !== 0) {
                // if (!utils.checkCRC(rom)) {
                throw new Error('CRC mismatch');
            }

            this.lastFound = rom;
            this.lastConflict = lastConflict;

            // return rom.toString('hex');
            return Hex.toString(rom);

        };

        this._resetWire();
        this.writeData(cmds.ONE_WIRE_SEARCH_ROM);
        return searchNextBit();

    }

    readROM() {
        this._resetWire();
        this.writeData(cmds.ONE_WIRE_READ_ROM);
        let rom = this.readData(ROM_SIZE);

        if (rom.length < 1) {
            return;
        }

        if (rom[0] === 0) {
            throw new Error('ROM invalid');
        }

        if (this.crc8(rom) !== 0) {
            // if (!utils.checkCRC(rom)) {
            throw new Error('CRC mismatch');
        }

        //return rom.toString('hex');
        return Hex.toString(rom);
    }

    matchROM(rom) {
        if (typeof rom !== 'string') {
            throw new TypeError(`${rom}: Type not string.`);
        }

        if (rom.length !== ROM_SIZE * 2) {
            throw new Error(`${rom}: ROM invalid.`);
        }

        if (rom[0] === "0" && rom[1] === "0") {
            throw new Error(`${rom}: ROM invalid.`);
        }

        let rb = Hex.toBuffer(rom);

        this._resetWire();
        this.writeData(cmds.ONE_WIRE_MATCH_ROM);
        return this.writeData(rb);
    }

    skipROM() {
        this._resetWire();
        return this.writeData(cmds.ONE_WIRE_SKIP_ROM);
    }

    resumeROM() {
        return this.writeData(cmds.ONE_WIRE_RESUME_COMMAND);
    }

    /*
     * Onewire read/write API
     */

    writeData(data, length) {
        // if (!(data instanceof Buffer)) {
        //     // eslint-disable-next-line no-param-reassign
        //     data = Buffer.from(Array.isArray(data) ? data : [data]);
        // }

        if (data instanceof ArrayBuffer) {
            data = new Uint8Array(data);
        } else if (!(data instanceof Uint8Array)) {
            data = Uint8Array.from(Array.isArray(data) ? data : [data]);
        }

        length = length ?? data.length;

        let offset = 0;

        const writeNextByte = () => {
            this._i2cWrite([cmds.ONE_WIRE_WRITE_BYTE, data[offset]]);
            let resp = this._wait();

            offset += 1;
            if (offset < length) {
                return writeNextByte();
            }

            return resp;
        };

        this._wait(true);
        return writeNextByte();
    }

    readData(size) {
        const data = new Uint8Array(size);

        let offset = 0;

        const readNextByte = () => {
            this._i2cWrite([cmds.ONE_WIRE_READ_BYTE]);
            this._wait();
            let resp = this._readBridge(cmds.REGISTERS.DATA);

            // data.writeUInt8(resp, offset);
            data[offset] = resp;

            offset += 1;
            if (offset < data.length) {
                return readNextByte();
            }

            return data;
        }

        this._wait(true);
        return readNextByte();
    }

    bit(setHigh) {
        this._wait(true);
        this._i2cWrite([cmds.ONE_WIRE_SINGLE_BIT, setHigh ? 0x80 : 0]);
        let resp = this._wait();
        return (resp & cmds.STATUS.SINGLE_BIT ? 1 : 0);
    }

    triplet(dir) {
        this._wait(true);
        this._i2cWrite([cmds.ONE_WIRE_TRIPLET, dir ? 0x80 : 0]);
        return this._wait();

    }

    /*
     * Private Methods
     */

    _resetBridge() {
        this._i2cWrite([cmds.DEVICE_RESET]);
        let resp = this._wait();
        this.channel = 0;
        return resp;
    }

    _resetWire() {

        // trace("_resetWire: _wait\n");
        this._wait(true);
        // trace("_resetWire: _i2cWrite\n");
        this._i2cWrite([cmds.ONE_WIRE_RESET]);
        // trace("_resetWire: _wait\n");
        let resp = this._wait();

        // trace("_resetWire: " + JSON.stringify(resp) + "\n");

        if (resp & cmds.STATUS.SHORT) {
            throw new Error('Detected onewire short');
        }

        if (!(resp & cmds.STATUS.PRESENCE)) {
            throw new Error('Failed to detected any onewire devices');
        }

        return resp;
    }


    _readBridge(reg) {
        if (reg) {
            // trace("_readBridge: " + JSON.stringify(reg) + "\n");
            this._i2cWrite([cmds.SET_READ_POINTER, reg]);
        }

        // trace("_readBridge: _i2cRead\n");
        let r = this._i2cRead();
        // trace("_readBridge: _i2cRead: done\n");
        // trace("_readBridge: r ->" + JSON.stringify(r) + "\n");
        // trace("_readBridge: ret ->" + JSON.stringify(((r >>> 0) & 0xFF)) + "\n");
        return ((r >>> 0) & 0xFF)
    }


    _i2cWrite(bytesArray) {

        // trace("write: " + cmd + ", " + JSON.stringify(bytes) + "\n");

        // let args = [cmd];
        // if (bytes) {
        //     if (Array.isArray(bytes)) {
        //         args = args.concat(bytes);
        //     } else if (bytes instanceof Buffer) {
        //         args = args.concat(...bytes);
        //     } else {
        //         throw new TypeError("'bytes' of _i2cWrite is of type " + typeof (bytes) + ".");
        //     }
        // }

        // trace("write: " + JSON.stringify(Uint8Array.from(args)) + "\n");

        // from: Moddable/moddable/modules/io/expander/expander.js
        try {
            // trace("_i2cWrite: write\n");
            this.i2c.write(Uint8Array.from(bytesArray), true);
        } catch (e) {
            throw new Error("I2C: Write failed.", e.fileName, e.lineNumber);
        }
        // trace("_i2cWrite: done\n");
    }

    _i2cRead() {
        let read;
        let length;
        try {

            read = new Uint8Array(1);
            // trace("_i2cRead: rr\n");
            length = this.i2c.read(read, true);
            // trace(`_i2cRead: rr -> length: ${rr.byteLength}\n`);
            // trace("_i2cRead: rr -> read\n");
            // read = new Uint8Array(rr);
            // trace("_i2cRead: rr -> read: done\n");
            // trace("_i2cRead: " + JSON.stringify(read) + "\n");
        } catch (e) {
            // trace("_i2cRead: err\n");
            throw new Error("I2C: Read failed.", e.fileName, e.lineNumber);
        }
        // trace("_i2cRead: [0]\n");
        // let res = read[0] & 0xFF;
        // trace("_i2cRead: null\n");
        // read = null;
        // trace("_i2cRead: " + res + "\n");

        // would it be better to return undefined here?
        return length > 0 ? (read[0] & 0xFF) : undefined;
    }

    /*
        1-Wire device access API by path
     */

    // class generic {

    //     paths = {
    //         "not_implemented": []
    //     }

    // }

    #get_worker(family_code) {

        if (!this.#workers[family_code]) {

            // check if there's a module defined for this family code
            if (family_code in this.#modules4devices) {
                // if so: import it!
                this.#modules[family_code] = Modules.importNow(this.#modules4devices[family_code]);

                // invoke the default function
                this.#workers[family_code] = new this.#modules[family_code]()

            } else {
                // No device manager available to support this family code!
                if (!this.#modules['*generic*']) {
                    // create a single worker instance (and store this in #modules)!
                    this.#modules['*generic*'] = new owGeneric();
                }

                // create a reference to the generic worker instance
                this.#workers[family_code] = this.#modules['*generic*'];
            }

        }

        return this.#workers[family_code];
    }

    #get_paths(worker) {
        return Object.keys(worker?.paths)?.sort();
    }

    get paths() {
        let p = [];
        this.#devices = this.search();
        trace(JSON.stringify(this.#devices) + "\n");
        for (let d = 0, dl = this.#devices.length; d < dl; d++) {
            let id = this.#devices[d];
            // trace("id: " + id + "\n");
            let family = id.substring(0, 2);
            let worker = this.#get_worker(family);

            let paths = this.#get_paths(worker) || [];
            for (let i = 0, l = paths.length; i < l; i++) {
                p.push(`${id.substring(0, 2)}.${id.substring(2)}/${paths[i]}`);
            }
        }
        return p.sort();
    }

    readPath(path) {

        return new Promise((resolve, reject) => {

            if (typeof (path) !== "string") {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            path = path.toLowerCase();

            let pp = path.split("/");
            let id = pp.shift();

            if (!id || id.length < 16) {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            let family = id.substring(0, 2);

            // accept 28.FFFFFFF...
            // as well as 28FFFFFF...
            if (id[2] === ".") {
                id = family + id.substring(3);
            }

            // trace(id + "\n");

            let worker = this.#get_worker(family);
            let read_fn = worker?.paths?.[pp.join("/")]?.[0];
            let result;

            try {
                result = read_fn?.call(worker, this, id)
            } catch (err) {
                reject(err);
                return;
            }

            resolve(result);
        });
    }

    writePath(path, data) {

        return new Promise((resolve, reject) => {

            if (typeof (path) !== "string") {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            path = path.toLowerCase();

            let pp = path.split("/");
            let id = pp.shift();

            if (!id || id.length < 8) {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            let family = id.substring(0, 2);

            // accept 28.FFFFFFF...
            // as well as 28FFFFFF...
            if (id[2] === ".") {
                id = family + id.substring(3);
            }

            let worker = this.#get_worker(family);
            let write_fn = worker?.paths?.[pp.join("/")]?.[1];
            let result;

            try {
                result = write_fn?.call(worker, this, id, data);
            } catch (err) {
                reject(err);
                return;
            }

            resolve(result);
        });
    }


    // Utility functions - that can be used by device drivers

    crc8(uint8arr) {

        // definition by @moddable
        // 	{ poly: 0x31, init: 0x00, res: 0xA1, refIn: true,  refOut: true,  xorOut: 0x00, name: "CRC-8/MAXIM" },
        let crc = new CRC8(0x31, 0x00, true, true, 0x00);

        // crc.reset();
        return crc.checksum(uint8arr);
    }

    crc16(uint8arr) {

        // definition by @moddable
        // { poly: 0x8005, init: 0x0000, res: 0x44C2, refIn: true,  refOut: true,  xorOut: 0xFFFF, name: "CRC-16/MAXIM" },
        let crc = new CRC16(0x8005, 0, true, true, 0xFFFF);

        // crc.reset();
        return crc.checksum(uint8arr);
    }

    readUInt16LE(uint8arr, offset) {
        offset = offset >>> 0
        return uint8arr[offset] | (uint8arr[offset + 1] << 8)
    }

    readInt16LE(uint8arr, offset) {
        offset = offset >>> 0
        const val = uint8arr[offset] | (uint8arr[offset + 1] << 8)
        return (val & 0x8000) ? val | 0xFFFF0000 : val
    }
}

/************************/
/***** async API ********/


function timeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/*
 * Main API
 */


async function reset(bridge) {
    bridge.lastFound = null;
    bridge.lastConflict = 0;

    bridge.resetBridge();
    return bridge.resetWire();
}

async function configureBridge(bridge, options, confirm) {
    // let config = 0;

    options ??= {};

    await bridge.wait(true);
    bridge.i2cWrite([cmds.SET_READ_POINTER, cmds.REGISTERS.CONFIG]);
    let config = bridge.i2cRead() & 0x0F;

    if (options.activePullup) {
        config = (config & ~cmds.CONFIG.ACTIVE) | ((options.activePullup ? 1 : 0) * cmds.CONFIG.ACTIVE)
    }
    if (options.strongPullup) {
        config = (config & ~cmds.CONFIG.STRONG) | ((options.strongPullup ? 1 : 0) * cmds.CONFIG.STRONG)
    }
    if (options.overdrive) {
        config = (config & ~cmds.CONFIG.OVERDRIVE) | ((options.overdrive ? 1 : 0) * cmds.CONFIG.OVERDRIVE)
    }

    bridge.i2cWrite([cmds.WRITE_CONFIG, ((~config & 0x0F) << 4) | config]);

    let resp;
    if (confirm) {
        resp = await bridge.readBridge();
        if (config !== resp) {
            throw new Error('Failed to configure bridge');
        }
    }

    return resp;
}

async function selectChannel(bridge, num) {

    const ch = cmds.SELECTION_CODES[num || 0];
    if (!ch) {
        throw new Error('Invalid channel');
    }

    if (this.channel === num) {
        return ch.read;
    }

    await bridge.wait(true);
    await bridge.writeData(cmds.CHANNEL_SELECT, [ch.write]);
    let resp = await bridge.readBridge();

    if (ch.read !== resp) {
        throw new Error('Failed to select channel');
    }

    this.channel = num;
    return resp;
}

async function sendCommand(bridge, cmd, rom) {
    rom ? await bridge.matchROM(rom) : await bridge.skipROM();
    await bridge.writeData(cmd);
}

async function search(bridge) {
    bridge.lastFound = null;
    bridge.lastConflict = 0;

    const found = [];

    const searchNext = () => (

        bridge.searchROM()
            .then((resp) => {
                found.push(resp);

                if (bridge.lastConflict) {
                    return searchNext();
                }

                bridge.lastFound = null;
                bridge.lastConflict = 0;

                return found;
            })
    );

    return searchNext();
}

async function searchByFamily(bridge, family) {
    if (typeof family === 'string') {
        // eslint-disable-next-line no-param-reassign
        family = parseInt(family, 16);
    }

    bridge.lastFound = Uint8Array.of(family, 0, 0, 0, 0, 0, 0, 0);
    bridge.lastConflict = 64;

    const found = [];

    const searchNext = () => {

        bridge.searchROM()
            .then((resp) => {
                if (bridge.lastFound[0] === family) {
                    found.push(resp);
                }

                if (bridge.lastConflict > 7 && found.length) {
                    return searchNext();
                }

                bridge.lastFound = null;
                bridge.lastConflict = 0;

                return found;
            })
    }

    return searchNext();
}



async function wait(bridge, setPointer) {

    let reg = setPointer ? cmds.REGISTERS.STATUS : null;
    let resp;
    let t = Timer.set(() => {
        throw new Error('Wait timeout');
    }, 200);

    do {
        if (resp) {
            reg = null;
            await bridge.timeout(10);
        }
        try {
            resp = await bridge.readBridge(reg);
        } catch (err) {
            Timer.clear(t);
            throw err;
        }
    } while (resp & cmds.STATUS.BUSY)

    Timer.clear(t);
    return resp;
}

async function resetBridge(bridge) {
    bridge.i2cWrite([cmds.DEVICE_RESET]);
    let resp = await bridge.wait();
    this.channel = 0;
    return resp;
}

async function resetWire(bridge) {

    await bridge.wait(true);
    bridge.i2cWrite([cmds.ONE_WIRE_RESET]);
    let resp = await bridge.wait();

    // trace("_resetWire: " + JSON.stringify(resp) + "\n");

    if (resp & cmds.STATUS.SHORT) {
        throw new Error('Detected onewire short');
    }

    if (!(resp & cmds.STATUS.PRESENCE)) {
        throw new Error('Failed to detected any onewire devices');
    }

    return resp;
}


function readBridge(bridge, reg) {
    return new Promise((resolve) => {
        if (reg) {
            bridge.i2cWrite([cmds.SET_READ_POINTER, reg]);
        }

        let r = bridge.i2cRead();
        resolve((r >>> 0) & 0xFF);
        return;
    });
}


/*
 * Onewire ROM API
 */

async function searchROM(bridge) {
    const rom = new Uint8Array(ROM_SIZE);

    let offset = 0;
    let mask = 0x01;
    let bit = 1;
    let lastConflict = 0;

    const direction = () => {
        if (bridge.lastFound && bit < bridge.lastConflict) {
            return bridge.lastFound[offset] & mask;
        }

        return bit === bridge.lastConflict ? 1 : 0;
    };

    const searchNextBit = () => {
        // let d = direction();
        // trace("dir: " + d + "\n");

        bridge.triplet(direction())
            .then((resp) => {
                
                trace(`${resp}\n`);

                const sbr = (resp & cmds.STATUS.SINGLE_BIT);
                const tsb = (resp & cmds.STATUS.TRIPLE_BIT);
                const dir = (resp & cmds.STATUS.BRANCH_DIR);

                trace(resp + "\n");

                if (sbr && tsb) {
                    throw new Error('Bad search result');
                }

                if (!sbr && !tsb && !dir) {
                    lastConflict = bit;
                }

                const part = rom[offset];

                rom[offset] = dir ? part | mask : part & ~mask;

                mask <<= 1;
                bit += 1;

                if (mask > 128) {
                    offset += 1;
                    mask = 0x01;
                }

                if (offset < rom.length) {
                    return searchNextBit();
                }

                if (rom[0] === 0) {
                    throw new Error('ROM invalid');
                }

                if (bridge.crc8(rom) !== 0) {
                    // if (!utils.checkCRC(rom)) {
                    throw new Error('CRC mismatch');
                }

                bridge.lastFound = rom;
                bridge.lastConflict = lastConflict;

                // return rom.toString('hex');
                return Hex.toString(rom);

            });
    };

    await bridge.resetWire();
    let res = await bridge.writeData(cmds.ONE_WIRE_SEARCH_ROM)
            .then(() => {
                return searchNextBit();
            });
    // let res = await searchNextBit();
    return res;

}

async function readROM(bridge) {
    await bridge.resetWire();
    await bridge.writeData(cmds.ONE_WIRE_READ_ROM);
    let rom = await bridge.readData(ROM_SIZE);

    if (rom.length < 1) {
        return;
    }

    if (rom[0] === 0) {
        throw new Error('ROM invalid');
    }

    if (bridge.crc8(rom) !== 0) {
        // if (!utils.checkCRC(rom)) {
        throw new Error('CRC mismatch');
    }

    //return rom.toString('hex');
    return Hex.toString(rom);
}

async function matchROM(bridge, rom) {
    if (typeof rom !== 'string') {
        throw new TypeError(`${rom}: Type not string.`);
    }

    if (rom.length !== ROM_SIZE * 2) {
        throw new Error(`${rom}: ROM invalid.`);
    }

    if (rom[0] === "0" && rom[1] === "0") {
        throw new Error(`${rom}: ROM invalid.`);
    }

    let rb = Hex.toBuffer(rom);

    await bridge.resetWire();
    await bridge.writeData(cmds.ONE_WIRE_MATCH_ROM);
    return bridge.writeData(rb);

}

async function skipROM(bridge) {
    resetWire(bridge);
    return writeData(bridge, cmds.ONE_WIRE_SKIP_ROM);
}

async function resumeROM(bridge) {
    return writeData(bridge, cmds.ONE_WIRE_RESUME_COMMAND);
}

/*
 * Onewire read/write API
 */

async function writeData(bridge, data, length) {

    if (data instanceof ArrayBuffer) {
        data = new Uint8Array(data);
    } else if (!(data instanceof Uint8Array)) {
        data = Uint8Array.from(Array.isArray(data) ? data : [data]);
    }

    length = length ?? data.length;

    let offset = 0;

    const writeNextByte = () => {
        bridge.i2cWrite([cmds.ONE_WIRE_WRITE_BYTE, data[offset]]);
        bridge.wait().then((resp) => {
            offset += 1;
            if (offset < length) {
                return writeNextByte();
            }

            return resp;
        });
    };

    await bridge.wait(true);
    return writeNextByte();
}

async function readData(bridge, size) {
    const data = new Uint8Array(size);

    let offset = 0;

    const readNextByte = () => {
        bridge.i2cWrite([cmds.ONE_WIRE_READ_BYTE]);
        bridge.wait()
            .then(() => bridge.readBridge(cmds.REGISTERS.DATA))
            .then((resp) => {
                data[offset] = resp;

                offset += 1;
                if (offset < data.length) {
                    return readNextByte();
                }

                return data;
            })
    };

    await bridge.wait(true);
    return readNextByte();
}

async function bit(bridge, setHigh) {
    await bridge.wait(true);
    bridge.i2cWrite([cmds.ONE_WIRE_SINGLE_BIT, setHigh ? 0x80 : 0]);
    let resp = await bridge.wait();
    return (resp & cmds.STATUS.SINGLE_BIT ? 1 : 0);
}

async function triplet(bridge, dir) {
    await bridge.wait(true);
    bridge.i2cWrite([cmds.ONE_WIRE_TRIPLET, dir ? 0x80 : 0]);
    return bridge.wait();
}


class DS2482 {

    /* the table to translate family codes to module names shall be defined in the
     * manifest.json:
     *  {
     *      config: {
     *          ds2482: {
     *              <family_code>: <module_name>
     *          }
     *      }
     *  }
     */

    #modules4devices = config_from_manifest?.ds2482?.devices;
    #modules = {};

    #devices = [];
    #workers = {};

    constructor(i2c) {
        // eslint-disable-next-line no-param-reassign
        // options = options || {};

        this.i2c = i2c;
        this.channel = null;
    }


    init() {
        return reset(this);
    }

    reset() {
        return reset(this);
    }

    configureBridge(options, confirm) {
        configureBridge(this, options, confirm);
    }

    strongPullup() {
        this.configureBridge({ strongPullup: true });
    }

    selectChannel(num) {
        return selectChannel(this, num);
    }

    sendCommand(cmd, rom) {
        return sendCommand(this, cmd, rom)
    }

    search() {
        return search(this);
    }

    searchByFamily(family) {
        return searchByFamily(this, family);
    }

    searchROM(rom) {
        return searchROM(this, rom);
    }

    readROM() {
        return readROM(this, rom);
    }

    matchROM(rom) {
        return matchROM(this, rom);
    }

    skipROM() {
        return skipROM(this);
    }

    resumeROM(rom) {
        return resumeROM(this, rom);
    }

    writeData(data, length) {
        return writeData(this, data, length);
    }




    /*
 *  Main Bridge API
 */
    timeout(ms) {
        return timeout(ms);
    }

    /*
     *  1-Wire API
     */

    wait(setPointer) {
        return wait(this, setPointer);
    }

    resetBridge() {
        return resetBridge(this);
    }

    readBridge(reg) {
        return readBridge(this, reg);
    }

    resetWire() {
        return resetWire(this);
    }

    readData(size) {
        return readData(this, size);
    }

    bit(setHigh) {
        return bit(this, setHigh);
    }

    triplet(dir) {
        return triplet(this, dir);
    }

    resetBridge() {
        return resetBridge(this);
    }

    resetWire() {
        return resetWire(this);
    }

    readBridge(reg) {
        return readBridge(this, reg);
    }


    /*
     * Node-RED path like API
     */

    #get_worker(family_code) {

        if (!this.#workers[family_code]) {

            // check if there's a module defined for this family code
            if (family_code in this.#modules4devices) {
                // if so: import it!
                this.#modules[family_code] = Modules.importNow(this.#modules4devices[family_code]);

                // invoke the default function
                this.#workers[family_code] = new this.#modules[family_code]()

            } else {
                // No device manager available to support this family code!
                if (!this.#modules['*generic*']) {
                    // create a single worker instance (and store this in #modules)!
                    this.#modules['*generic*'] = new owGeneric();
                }

                // create a reference to the generic worker instance
                this.#workers[family_code] = this.#modules['*generic*'];
            }

        }

        return this.#workers[family_code];
    }

    #get_paths(worker) {
        return Object.keys(worker?.paths)?.sort();
    }

    get paths() {

        return new Promise((resolve) => {
            this.search()
                .then((devs) => {

                    this.#devices = devs;
                    let p = [];

                    trace(JSON.stringify(this.#devices) + "\n");
                    trace(typeof this.#devices + "\n");

                    if (typeof this.#devices == "undefined") {
                        resolve([]);
                        return;
                    }

                    for (let d = 0, dl = this.#devices.length; d < dl; d++) {
                        let id = this.#devices[d];
                        // trace("id: " + id + "\n");
                        let family = id.substring(0, 2);
                        let worker = this.#get_worker(family);

                        let paths = this.#get_paths(worker) || [];
                        for (let i = 0, l = paths.length; i < l; i++) {
                            p.push(`${id.substring(0, 2)}.${id.substring(2)}/${paths[i]}`);
                        }
                    }
                    resolve(p.sort());
                })
        })
    }

    readPath(path) {

        return new Promise((resolve, reject) => {

            if (typeof (path) !== "string") {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            path = path.toLowerCase();

            let pp = path.split("/");
            let id = pp.shift();

            if (!id || id.length < 16) {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            let family = id.substring(0, 2);

            // accept 28.FFFFFFF...
            // as well as 28FFFFFF...
            if (id[2] === ".") {
                id = family + id.substring(3);
            }

            // trace(id + "\n");

            let worker = this.#get_worker(family);
            let read_fn = worker?.paths?.[pp.join("/")]?.[0];

            if (read_fn) {
                read_fn.call(worker, this, id)
                    .then((result) => {
                        resolve(result);
                        return;
                    })
                    .catch((err) => {
                        reject(err);
                        return;
                    })
            }

            resolve(undefined);

        });
    }

    writePath(path, data) {

        return new Promise((resolve, reject) => {

            if (typeof (path) !== "string") {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            path = path.toLowerCase();

            let pp = path.split("/");
            let id = pp.shift();

            if (!id || id.length < 8) {
                throw new RangeError(`'${path}' is an invalid path.`)
            }

            let family = id.substring(0, 2);

            // accept 28.FFFFFFF...
            // as well as 28FFFFFF...
            if (id[2] === ".") {
                id = family + id.substring(3);
            }

            let worker = this.#get_worker(family);
            let write_fn = worker?.paths?.[pp.join("/")]?.[1];

            if (write_fn) {
                write_fn.call(worker, this, id)
                    .then((result) => {
                        resolve(result);
                        return;
                    })
                    .catch((err) => {
                        reject(err);
                        return;
                    })
            }

            resolve(undefined);

        });
    }



    /*
     * i2c API
     */

    i2cWrite(bytesArray) {
        try {
            this.i2c.write(Uint8Array.from(bytesArray), true);
        } catch (e) {
            throw new Error("I2C: Write failed.", e.fileName, e.lineNumber);
        }
    }

    i2cRead() {
        let read;
        let length;
        try {
            read = new Uint8Array(1);
            length = this.i2c.read(read, true);
        } catch (e) {
            throw new Error("I2C: Read failed.", e.fileName, e.lineNumber);
        }

        return length > 0 ? (read[0] & 0xFF) : undefined;
    }

    // Utility functions - that can be used by device drivers

    crc8(uint8arr) {

        // definition by @moddable
        // 	{ poly: 0x31, init: 0x00, res: 0xA1, refIn: true,  refOut: true,  xorOut: 0x00, name: "CRC-8/MAXIM" },
        let crc = new CRC8(0x31, 0x00, true, true, 0x00);

        // crc.reset();
        return crc.checksum(uint8arr);
    }

    crc16(uint8arr) {

        // definition by @moddable
        // { poly: 0x8005, init: 0x0000, res: 0x44C2, refIn: true,  refOut: true,  xorOut: 0xFFFF, name: "CRC-16/MAXIM" },
        let crc = new CRC16(0x8005, 0, true, true, 0xFFFF);

        // crc.reset();
        return crc.checksum(uint8arr);
    }

    readUInt16LE(uint8arr, offset) {
        offset = offset >>> 0
        return uint8arr[offset] | (uint8arr[offset + 1] << 8)
    }

    readInt16LE(uint8arr, offset) {
        offset = offset >>> 0
        const val = uint8arr[offset] | (uint8arr[offset + 1] << 8)
        return (val & 0x8000) ? val | 0xFFFF0000 : val
    }

}

// module.exports = DS2482;
export { DS2482 };
