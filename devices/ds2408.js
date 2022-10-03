/*
    node-red-DS2482-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-DS2482-mcu
    License: MIT
*/

import {Buffer} from "buffer";
import {CRC16} from "crc";

class ds2408 {

    paths = {
        "power": [this.power_get],
        "disable_test_mode": [undefined, this.disable_test_mode],
        "strobe": [this.strobe_get, this.strobe_set],
        "por": [this.por_get, this.por_set],
        "sensed/all": [this.state_get],
        "pio/all": [this.pio_get, this.pio_set],
        "latch/all": [this.latch_get, this.latch_reset],
    }

    constructor () {
        for (let i=0;i<8;i++) {
            this.paths["sensed/ch" + i] = [ds2408.prototype["state_get" + i]];
            this.paths["pio/ch" + i] = [ds2408.prototype["pio_get" + i], ds2408.prototype["pio_set" + i]];
            this.paths["latch/ch" + i] = [ds2408.prototype["latch_get" + i]];
        }
    }

    #cmds = Object.freeze({
        READ_PIO: 0xF0,
        CHANNEL_ACCESS_READ: 0xF5,
        CHANNEL_ACCESS_WRITE: 0x5A,
        WRITE_REGISTER: 0xCC,
        RESET_LATCHES: 0xC3,
    })

    #channels = Object.freeze({
        CH0: (1 << 0),
        CH1: (1 << 1),
        CH2: (1 << 2),
        CH3: (1 << 3),
        CH4: (1 << 4),
        CH5: (1 << 5),
        CH6: (1 << 6),
        CH7: (1 << 7),
    })

    #bits = Object.freeze({
        PLS: (1 << 0),
        CT: (1 << 1),
        ROS: (1 << 2),
        PORL: (1 << 3),
        VCCP: (1 << 7)
    })

    #registers = Object.freeze({
        LOGIC_STATE: 0x88,
        OUTPUT_LATCH_STATE: 0x89,
        ACTIVITY_LATCH_STATE: 0x8A,
        SELECTION_MASK: 0x8B,
        POLATITY: 0x8C,
        CONTROL_STATUS: 0x8D
    })

    #register_read(bridge, id, target) {

        if (target) {
            if (target < 0x88) { return 0; }
            if (target > 0x8d) { return 0xFF; }    
        }
        
        let cmd = Buffer.from([this.#cmds.READ_PIO, 0x88, 0]);

        // { poly: 0x8005, init: 0x0000, res: 0x44C2, refIn: true,  refOut: true,  xorOut: 0xFFFF, name: "CRC-16/MAXIM" },
        let crc16 = new CRC16(0x8005, 0, true, true, 0xFFFF);

        let checksum;
        let crc;
        let regs;
        let count = 5

        do {
            // initialisation
            crc16.reset();
            crc16.checksum(cmd.buffer);

            bridge.matchROM(id);
            trace("writing: " + cmd.toString("hex") + "\n");
            // debugger;
            bridge.writeData(cmd);
            regs = bridge.readData(10);  // registers until 0x8f, then crc16
            trace("#register_read: " + JSON.stringify(regs) + "\n");

            checksum = regs.readUInt16LE(8); // crc16 in 2 last bytes

            let cbuf = Buffer.from(regs.buffer, 0, 8);
            crc = crc16.checksum(cbuf);

            trace("crc: " + crc.toString(16) + " | checksum: " + checksum.toString(16) + "\n");
            count--;

        } while (true == false) // (checksum != crc && count > -1)

        if (target) {
            return regs.readUInt8(target - 0x88);   
        }

        return regs;
    }

    #register_write(bridge, id, data, target, invert) {
        if (!data) return;
        if (target < 0x8B || target > 0x8D) return;

        data = invert ? (data ^ 0xFF) : data;

        bridge.matchROM(id);
        bridge.writeData([this.#cmds.WRITE_REGISTER, target, 0, (data & 0xFF)]);
        bridge._resetWire();
    }

    #bit_get(value, bit) {
        return ((value >> bit) % 2);
    }

    #bit_set(value, bit, status) {
        return status ? (value | 1<<bit) : (value & ~(1<<bit));
    }

    #register_bit_get(bridge, id, register, bit, invert) {
        let reg = this.#register_read(bridge, id, register);
        reg = invert ? (reg ^ 0xFF) : reg
        return this.#bit_get(reg, bit);
    }

    #register_bit_set(bridge, id, register, bit, state, invert) {
        invert = invert ? 1 : 0;
        state = state ? 1-invert : 0+invert;
        let reg = this.#register_read(bridge, id, register);
        reg = this.#bit_set(reg, bit, state);

        do {
            this.#register_write(bridge, id, register);
            let check = this.#register_read(bridge, id, register);
        } while (check != reg)
    }

    power_get(bridge, id) {
        return this.#register_bit_get(bridge, id, this.#registers.CONTROL_STATUS, this.#bits.VCCP);
    }

    por_get(bridge, id) {
        return this.#register_bit_get(bridge, id, this.#registers.CONTROL_STATUS, this.#bits.PORL);
    }

    por_set(bridge, id, data) {
        data = data ? 1 : 0;
        this.#register_bit_set(bridge, id, this.#registers.CONTROL_STATUS, this.#bits.PORL, state);
    }

    strobe_get(bridge, id) {
        return this.#register_bit_get(bridge, id, this.#registers.CONTROL_STATUS, this.#bits.ROS);
    }

    strobe_set(bridge, id, data) {
        return this.#register_bit_set(bridge, id, this.#registers.CONTROL_STATUS)
    }

    disable_test_mode(bridge, id) {
        // magic command...
        bridge.matchROM(id);
        bridge.writeData([0x96, id, 0x3C]);
        bridge._resetWire();
    }

    latch_reset(bridge, id) {
        bridge.matchROM(id);
        let count = 5;
        do {
            bridge.writeData(this.#cmds.RESET_LATCHES);
            let res = bridge.readData(1);
            count--;
        } while (res != 0xAA & count > -1);
    }

    #pio_set_channel(bridge, id, channel, data) {

        // to be sure!
        this.disable_test_mode();

        let reg;

        if (channel) {
            reg = this.#register_read(bridge, id, this.#registers.OUTPUT_LATCH_STATE);
            reg = this.#bit_set(reg, channel, (data ? 1 : 0));
        } else {
            reg = data;
        }

        // reg = (reg ^ 0xFF) & 0xFF ; // invert bits & limit to byte
        reg = reg & 0xFF;

        bridge.writeData([this.#cmds.CHANNEL_ACCESS_WRITE, reg, (~reg & 0xFF)]);
        let res = bridge.readData(1);

        return (res == 0xAA);
    }

    // 0x88, inverted
    state_get(bridge, id) { return this.#register_read(bridge, id, this.#registers.LOGIC_STATE); }
    state_get0(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH0); }
    state_get1(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH1); }
    state_get2(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH2); }
    state_get3(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH3); }
    state_get4(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH4); }
    state_get5(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH5); }
    state_get6(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH6); }
    state_get7(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.LOGIC_STATE, this.#channels.CH7); }

    // 0x89, inverted
    pio_get(bridge, id) { return this.#register_read(bridge, id, this.#registers.OUTPUT_LATCH_STATE); }
    pio_get0(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH0); }
    pio_get1(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH1); }
    pio_get2(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH2); }
    pio_get3(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH3); }
    pio_get4(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH4); }
    pio_get5(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH5); }
    pio_get6(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH6); }
    pio_get7(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.OUTPUT_LATCH_STATE, this.#channels.CH7); }

    pio_set(bridge, id, data) { return this.#pio_set_channel(bridge, id, data); }
    pio_set0(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH0, data); }
    pio_set1(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH1, data); }
    pio_set2(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH2, data); }
    pio_set3(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH3, data); }
    pio_set4(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH4, data); }
    pio_set5(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH5, data); }
    pio_set6(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH6, data); }
    pio_set7(bridge, id, data) { return this.#pio_set_channel(bridge, id, this.#channels.CH7, data); }

    // 0x8a
    latch_get(bridge, id) { return this.#register_read(bridge, id, this.#registers.ACTIVITY_LATCH_STATE); }
    latch_get0(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH0); }
    latch_get1(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH1); }
    latch_get2(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH2); }
    latch_get3(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH3); }
    latch_get4(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH4); }
    latch_get5(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH5); }
    latch_get6(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH6); }
    latch_get7(bridge, id) { return this.#register_bit_get(bridge, id, this.#registers.ACTIVITY_LATCH_STATE, this.#channels.CH7); }
}

export { ds2408 as default}