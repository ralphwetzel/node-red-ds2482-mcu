/*
    node-red-DS2482-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-DS2482-mcu
    License: MIT
*/

import Timer from "timer";

class ds2438 {

    paths = Object.freeze({
        "humidity": [this.humidity_3600],
        "temperature": [this.temp_read],
        "latesttemp": [this.temp_fetch],
        "vad": [this.vad],
        "vdd": [this.vdd],
        "hih4000/humidity": [this.humidity_4000],
        "hih3600/humidity": [this.humidity_3600],
        "sfh5711/illuminance": [this.illuminance_5711],
    })

    cmds = Object.freeze({
        WRITE_SCRATCHPAD: 0x4E,
        READ_SCRATCHPAD: 0xBE,
        COPY_SCRATCHPAD: 0x48,
        RECALL_SCRATCHPAD: 0xB8,
        CONVERT_TEMP: 0x44,
        CONVERT_VOLT: 0xB4
    })

    bits = Object.freeze({
        IAD: 0,
        CA: 1,
        EE: 2,
        AD: 3,
        TB: 4,
        NVB: 5,
        ADB: 6
    })

    temp_read(bridge, id) {
        return temp_read(this, bridge, id);
    }

    temp_fetch(bridge, id) {
        return temp_fetch(this, bridge, id);
    }

    vad(bridge, id) {
        return volts(this, bridge, id, 0);
    }

    vdd(bridge, id) { 
        return volts(this, bridge, id, 1);
    }

    vsense(bridge, id) {
        return current(this, bridge, id);
    }

    // HIH-36xx
    humidity_3600(bridge, id) {
        return humidity_3600(this, bridge, id); 
    }

    // HIH-40xx
    humidity_4000(bridge, id) {
        return humidity_4000(this, bridge, id); 
    }

    // SFH-5711
    illuminance_5711(bridge, id) { 
        return illuminance_5711(this, bridge, id); 
    }

}

function make_error(id, msg) {
    return new Error(`${id.substring(0,2)}.${id.substring(2)}: ${msg}`);
}

async function temp_read(self, bridge, id) {
    await bridge.matchROM(id);
    await bridge.writeData([self.cmds.CONVERT_TEMP]);
    await bridge.timeout(10);
    return temp_fetch(self, bridge, id);
}

async function temp_fetch(self, bridge, id) {
    let sp = await read_sp(self, bridge, id, 0);
    if (!sp) 
        throw make_error(id, "Device not present.");

    let t = bridge.readUInt16LE(sp, 1);
    return t / 256.0;
}

async function read_sp(self, bridge, id, page, length) {

    length ??= 9;

    let count = 0;
    let crc;
    let sp;

    await bridge.matchROM(id);
    await bridge.writeData([self.cmds.RECALL_SCRATCHPAD, page]);

    async function r(b, i, p, l) {
        // trace("#read_sp: matchROM\n");
        await b.matchROM(i);
        // trace("#read_sp: writeData\n");
        await b.writeData([self.cmds.READ_SCRATCHPAD, p]);
        // trace("#read_sp: readData\n");
        return b.readData(l);
    }

    // no crc check!
    if (length < 9) { 
        sp = await r(bridge, id, page, length);
        await bridge._resetWire();
    } else {
        do {
            sp = await r(bridge, id, page, length);
            count++;
            crc = bridge.crc8(sp);
            // trace (`crc@#read_sp: ${crc}\n`);
        } while (crc !== 0 && count < 5)    
    }

    // trace(`sp: ${sp}\n`);

    // in case the device is not present
    // each byte reads 0xFF!
    for (let i=0, l=sp.length; i<l; i++) {
        if (sp[i] != 0xFF) {
            return sp;
        }
    }

    throw make_error(id, "Device not present");
}

async function write_sp(self, bridge, id, page, data, length) {

    length ??= 8;

    await bridge.matchROM(id);
    await bridge.writeData([self.cmds.WRITE_SCRATCHPAD, page]);
    await bridge.writeData(data, length);

    if (length < 8) {
        await bridge._resetWire();
    }
}

function bit_get(value, bit) {
    return ((value >> bit) % 2);
}

function bit_set(value, bit, status) {
    return status ? (value | 1<<bit) : (value & ~(1<<bit));
}

async function set_register(self, bridge, id, register, status) {

    // read first page, first byte
    let sp = await read_sp(self, bridge, id, 0, 1);

    if (sp.length < 1)
        throw make_error(id, "Failed to read device data.");

    let sc = sp[0];

    if (bit_get(sc, register) == status) {
        return;
    }

    sp[0] = bit_set(sc, register, status);

    // write just the first byte!
    await write_sp(self, bridge, id, 0, sp, 1);

}

// volts_fetch(bridge, id) {
//     let sp = this.#read_sp(bridge, id, 0);
//     let v = sp.readUInt16LE(3);
//     return (.01 * v);
// }

async function volts(self, bridge, id, source) {

    // trace("@ #volts: set_register\n");
    await set_register(self, bridge, id, self.bits.AD, source);

    // trace("@ #volts: matchROM\n");
    await bridge.matchROM(id);
    
    // trace("@ #volts: writeData\n");
    await bridge.writeData([self.cmds.CONVERT_VOLT]);
    await bridge.timeout(10);

    // return this.volts_fetch(bridge, id);

    // trace("@ #volts: #read_sp\n");
    let sp = await read_sp(self, bridge, id, 0);

    if (sp.length < 9) {
        throw make_error(id, "Failed to read device data.") 
    }

    // trace("@ #volts: readUInt16LE\n");
    let v = bridge.readUInt16LE(sp, 3);
    return (.01 * v);
}

async function current(self, bridge, id) {
    await set_register(self, bridge, id, self.bits.IAD, 1);
    await bridge.timeout(10);

    let sp = await read_sp(self, bridge, id, 0);
    if (sp.length < 9) {
        throw make_error(id, "Failed to read device data.") 
    }

    let v = bridge.readUInt16LE(sp, 5);
    return (.2441 * v);     // resolution: 0.2441mV
}

// HIH-36xx
async function humidity_3600(self, bridge, id) {
    let _t = await temp_read(self, bridge, id);
    // trace("temp_read done\n");
    let _vad = await self.vad(bridge, id);
    // trace("vad done\n");
    let _vdd = await self.vdd(bridge, id);
    // trace("all done\n");

    if (!_t || !_vad || !_vdd || _vdd<.01) return;

    let humidity_uncompensated = ((_vad/_vdd) - (0.8 / _vdd)) / 0.0062;
    let temperature_compensation = 1.0546 - 0.00216 * _t;
    return humidity_uncompensated / temperature_compensation;
}

// HIH-40xx
async function humidity_4000(self, bridge, id) {
    let _t = await temp_read(self, bridge, id);
    let _vad = await self.vad(bridge, id);
    let _vdd = await self.vdd(bridge, id);

    if (!_t || !_vad || !_vdd || _vdd<.01) return;

    let humidity_uncompensated = ((_vad/_vdd) - 0.16) / 0.0062;
    let temperature_compensation = 1.0546 - 0.00216 * _t;
    return humidity_uncompensated / temperature_compensation;
}

// SFH-5711
async function illuminance_5711(self, bridge, id) {
    let _vsense = await self.vsense(bridge, id);
    if (!_vsense) return;

    return 10^((_vsense/47)*1000);
}

export { ds2438 as default}