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

    #cmds = Object.freeze({
        WRITE_SCRATCHPAD: 0x4E,
        READ_SCRATCHPAD: 0xBE,
        COPY_SCRATCHPAD: 0x48,
        RECALL_SCRATCHPAD: 0xB8,
        CONVERT_TEMP: 0x44,
        CONVERT_VOLT: 0xB4
    })

    #bits = Object.freeze({
        IAD: 0,
        CA: 1,
        EE: 2,
        AD: 3,
        TB: 4,
        NVB: 5,
        ADB: 6
    })

    temp_read(bridge, id) {
        bridge.matchROM(id);
        bridge.writeData([this.#cmds.CONVERT_TEMP]);
        Timer.delay(10);
        return this.temp_fetch(bridge, id);
    }

    temp_fetch(bridge, id) {
        let sp = this.#read_sp(bridge, id, 0);
        let t = sp.readUInt16LE(1);
        return t / 256.0;
    }

    #read_sp(bridge, id, page, length) {

        length = length ?? 9;

        let self = this;
        let count = 0;
        let crc;
        let sp;

        function r(b, i, p, l) {
            b.matchROM(i);
            b.writeData([self.#cmds.READ_SCRATCHPAD, p]);
            return b.readData(l);
        }

        // no crc check!
        if (length < 9) { 
            sp = r(bridge, id, page, length);
            bridge._resetWire();
            return sp;
        }

        do {
            sp = r(bridge, id, page, length);
            count++;
            crc = bridge.checkCRC(sp)
        } while (true == false) // ((crc === false) && count < 5)

        return sp;
    }

    #write_sp(bridge, id, page, data, length) {

        length = length ?? 8;

        bridge.matchROM(id);
        bridge.writeData([this.#cmds.WRITE_SCRATCHPAD, page]);
        bridge.writeData(data, length);

        if (length < 8) {
            bridge._resetWire();
        }
    }

    #bit_get(value, bit) {
        return ((value >> bit) % 2);
    }

    #bit_set(value, bit, status) {
        return status ? (value | 1<<bit) : (value & ~(1<<bit));
    }

    #set_register(bridge, id, register, status) {

        // read first page, first byte
        let sp = this.#read_sp(bridge, id, 0, 1);
        let sc = sp.readUInt8(0);

        if (this.#bit_get(sc, register) == status) {
            return;
        }

        sp[0] = this.#bit_set(sc, register, status);

        // write just the first byte!
        this.#write_sp(bridge, id, 0, sp, 1);

    }

    // volts_fetch(bridge, id) {
    //     let sp = this.#read_sp(bridge, id, 0);
    //     let v = sp.readUInt16LE(3);
    //     return (.01 * v);
    // }

    #volts(bridge, id, source) {
        this.#set_register(bridge, id, this.#bits.AD, source);
        bridge.matchROM(id);
        bridge.writeData([this.#cmds.CONVERT_VOLT]);
        Timer.delay(10);

        // return this.volts_fetch(bridge, id);
        
        let sp = this.#read_sp(bridge, id, 0);
        let v = sp.readUInt16LE(3);
        return (.01 * v);
    }

    vad(bridge, id) { 
        return this.#volts(bridge, id, 0);
    }

    vdd(bridge, id) { 
        return this.#volts(bridge, id, 1);
    }

    #current(bridge, id) {
        this.#set_register(bridge, id, this.#bits.IAD, 1);
        Timer.delay(50);

        let sp = this.#read_sp(bridge, id, 0);
        let v = sp.readUInt16LE(5);
        return (.2441 * v);     // resolution: 0.2441mV
    }

    vsense(bridge, id) {
        return this.#current(bridge, id);
    }

    // HIH-36xx
    humidity_3600(bridge, id) {
        let _t = this.temp_read(bridge, id);
        let _vad = this.vad(bridge, id);
        let _vdd = this.vdd(bridge, id);

        if (!_t || !_vad || !_vdd || _vdd<.01) {
            return -1;
        }

        let humidity_uncompensated = ((_vad/_vdd) - (0.8 / _vdd)) / 0.0062;
        let temperature_compensation = 1.0546 - 0.00216 * _t;
        return humidity_uncompensated / temperature_compensation;
    }

    // HIH-40xx
    humidity_4000(bridge, id) {
        let _t = this.temp_read(bridge, id);
        let _vad = this.vad(bridge, id);
        let _vdd = this.vdd(bridge, id);

        if (!_t || !_vad || !_vdd || _vdd<.01) {
            return -1;
        }

        let humidity_uncompensated = ((_vad/_vdd) - 0.16) / 0.0062;
        let temperature_compensation = 1.0546 - 0.00216 * _t;
        return humidity_uncompensated / temperature_compensation;
    }

    // SFH-5711
    illuminance_5711(bridge, id) {
        let _vsense = this.vsense(bridge, id);
        return 10^((_vsense/47)*1000);
    }

}

export { ds2438 as default}