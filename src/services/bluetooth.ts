
type BluetoothEventMap = {
  status: string;
  connected: { deviceName: string | null };
  disconnected: void;
  error: Error;

  write: { label: string; writes: number; frameLength: number };
  notify: { category: number; cmd: number; body: Uint8Array; bodyHex: string };

  uploadPrepare: {
    filename: string;
    rawBytes: number;
    alignedBytes: number;
    transferBytes: number;
    crc: string;
    chunks: number;
  };
  uploadProgress: { done: number; total: number };
  uploadComplete: void;

  cardStatus: string;
  cardsStatus: string;
  settingsStatus: string;
  carouselStatus: string;
};

type BluetoothEventName = keyof BluetoothEventMap;

type Listener<T> = (payload: T) => void;

type Waiter = {
  cmd: number;
  resolve: (body: Uint8Array) => void;
  reject: (err: Error) => void;
};

type ReassemblyState = {
  category: number | null;
  expectedLen: number | null;
  buffer: number[];
};

export type ControlSettings = {
  disableBroadcast: boolean;
  disableBuzzer: boolean;
  disableVibration: boolean;
  disableLight: boolean;
  disableInterestSensing: boolean;
  disableAmbienceLight: boolean;
  rawBytes: Uint8Array;
};

export type ReceivedCard = {
  id: number;
  raw: Uint8Array;
  rawHex: string;
  text: string;
};

export class BluetoothService {
  private readonly SERVICE_UUID = "00000000-0000-0000-6473-5f696c666973";
  private readonly DATA_CHAR_UUID = "00000000-0000-0200-6473-5f696c666973";

  private readonly CATEGORY_FILE = 0x04;
  private readonly CATEGORY_CONTROL = 0x1f;

  private readonly DEFAULT_CONTROL_INFO_BYTES = new Uint8Array([
    1, 1, 1, 1, 1, 1, 0, 1,
  ]);

  private readonly FileCommand = {
    START_REQUEST: 0,
    START_RESPONSE: 1,
    FILE_SEND_START_REQUEST: 2,
    FILE_SEND_START_RESPONSE: 3,
    FILE_SEND_DATA_REQUEST: 4,
    FILE_SEND_DATA_RESPONSE: 5,
    FILE_SEND_END_REQUEST: 6,
    FILE_SEND_END_RESPONSE: 7,
    END_REQUEST: 8,
    END_RESPONSE: 9,
    LOSE_CHECK_REQUEST: 10,
    LOSE_CHECK_RESPONSE: 11,
    FILE_INFO_REQUEST: 13,
    FILE_INFO_RESPONSE: 14,
  } as const;

  private readonly CardCommand = {
    SET_CARD_INFO: 14,
    RESP_CARD_INFO: 15,

    READ_CARD_INFO: 16,
    RESP_READ_CARD: 17,

    SET_TAGS: 34,
    RESP_TAGS: 35,

    READ_CARDS_COUNT: 36,
    RESP_CARDS_COUNT: 37,

    READ_CARD_BY_ID: 38,
    RESP_CARD_BY_ID: 39,

    DELETE_CARD: 40,
    RESP_DELETE_CARD: 41,
  } as const;

  private readonly ControlCommand = {
    CONTROL_INFO: 24,
    CONTROL_INFO_RESPONSE: 25,

    SET_CAROUSEL: 42,
    RESP_CAROUSEL: 43,

    READ_CAROUSEL: 44,
    RESP_CAROUSEL_RD: 45,
  } as const;

  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private dataChar: BluetoothRemoteGATTCharacteristic | null = null;

  private waiters: Waiter[] = [];
  private controlWaiters: Waiter[] = [];

  private currentControlSettings: ControlSettings | null = null;

  private listeners: {
    [K in BluetoothEventName]?: Set<Listener<BluetoothEventMap[K]>>;
  } = {};

  private reassembly: ReassemblyState = {
    category: null,
    expectedLen: null,
    buffer: [],
  };

  public on<K extends BluetoothEventName>(
    event: K,
    listener: Listener<BluetoothEventMap[K]>,
  ): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }

    this.listeners[event]!.add(listener);

    return () => this.off(event, listener);
  }

  public off<K extends BluetoothEventName>(
    event: K,
    listener: Listener<BluetoothEventMap[K]>,
  ): void {
    this.listeners[event]?.delete(listener);
  }

  private emit<K extends BluetoothEventName>(
    event: K,
    payload: BluetoothEventMap[K],
  ): void {
    for (const listener of this.listeners[event] ?? []) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[BluetoothService event ${event}] listener failed`, err);
      }
    }
  }

  public isConnected(): boolean {
    return Boolean(this.server?.connected && this.dataChar);
  }

  public async connect(): Promise<void> {
    this.emit("status", "Connecting");

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "MoniCard" }],
      optionalServices: [this.SERVICE_UUID],
    });

    if (!this.device.gatt) {
      throw new Error("Device does not expose GATT");
    }

    this.device.addEventListener("gattserverdisconnected", () => {
      this.emit("status", "Disconnected");
      this.emit("disconnected", undefined);
    });

    this.server = await this.device.gatt.connect();

    const service = await this.server.getPrimaryService(this.SERVICE_UUID);
    this.dataChar = await service.getCharacteristic(this.DATA_CHAR_UUID);

    this.dataChar.addEventListener("characteristicvaluechanged", this.onNotify);

    await this.dataChar.startNotifications();

    this.emit("connected", {
      deviceName: this.device.name ?? null,
    });

    this.emit("status", "Connected");
  }

  public async disconnect(): Promise<void> {
    if (this.dataChar) {
      try {
        await this.dataChar.stopNotifications();
      } catch {}
    }

    if (this.server?.connected) {
      this.server.disconnect();
    }

    this.dataChar = null;
    this.server = null;
    this.device = null;

    this.emit("status", "Disconnected");
    this.emit("disconnected", undefined);
  }

  private onNotify = async (event: Event): Promise<void> => {
    const target = event.target as BluetoothRemoteGATTCharacteristic | null;

    if (!target?.value) {
      return;
    }

    const data = new Uint8Array(target.value.buffer);
    const complete = this.reassemble(data);

    if (!complete) {
      return;
    }

    const category = complete[0];

    if (category === this.CATEGORY_FILE) {
      const parsed = this.parseFileFrame(complete);

      if (!parsed) {
        return;
      }

      this.emit("notify", {
        category,
        cmd: parsed.cmd,
        body: parsed.body,
        bodyHex: this.bytesToHex(parsed.body),
      });

      if (parsed.cmd === this.FileCommand.LOSE_CHECK_REQUEST) {
        await this.sendFrame(
          this.encodeLoseCheckResponse(),
          "LOSE_CHECK_RESPONSE",
        );
      }

      this.resolveWaiter(this.waiters, parsed.cmd, parsed.body);
      return;
    }

    if (category === this.CATEGORY_CONTROL) {
      const parsed = this.parseControlFrame(complete);

      if (!parsed) {
        return;
      }

      this.emit("notify", {
        category,
        cmd: parsed.cmd,
        body: parsed.body,
        bodyHex: this.bytesToHex(parsed.body),
      });

      this.resolveWaiter(this.controlWaiters, parsed.cmd, parsed.body);
      return;
    }

    console.warn("[unknown notify]", this.bytesToHex(complete));
  };

  private resolveWaiter(
    waiters: Waiter[],
    cmd: number,
    body: Uint8Array,
  ): void {
    const waiterIndex = waiters.findIndex((w) => w.cmd === cmd);

    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      waiter.resolve(body);
    }
  }

  private waitForFile(cmd: number, timeoutMs = 10_000): Promise<Uint8Array> {
    return this.waitForQueue(this.waiters, cmd, "file", timeoutMs);
  }

  private waitForControl(cmd: number, timeoutMs = 10_000): Promise<Uint8Array> {
    return this.waitForQueue(this.controlWaiters, cmd, "control", timeoutMs);
  }

  private waitForQueue(
    queue: Waiter[],
    cmd: number,
    label: string,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        cmd,
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
        reject,
      };

      const timer = window.setTimeout(() => {
        const idx = queue.indexOf(waiter);

        if (idx >= 0) {
          queue.splice(idx, 1);
        }

        reject(new Error(`Timeout waiting for ${label} cmd ${cmd}`));
      }, timeoutMs);

      queue.push(waiter);
    });
  }

  private async sendFrame(
    frame: Uint8Array,
    label: string,
    mtu = 512,
  ): Promise<void> {
    if (!this.dataChar) {
      throw new Error("Not connected");
    }

    const chunks = this.splitFrame(frame, mtu);

    this.emit("write", {
      label,
      writes: chunks.length,
      frameLength: frame.length,
    });

    for (const chunk of chunks) {
      if (chunk.length > 512) {
        throw new Error(`Web Bluetooth write too large: ${chunk.length} bytes`);
      }

      if ("writeValueWithoutResponse" in this.dataChar) {
        await this.dataChar.writeValueWithoutResponse(chunk);
      } else {
        await this.dataChar.writeValue(chunk);
      }

      await this.sleep(30);
    }
  }

  private async sendAndWaitFileStatus(
    frame: Uint8Array,
    writeLabel: string,
    expectedCmd: number,
    statusLabel: string,
    timeoutMs = 10_000,
  ): Promise<Uint8Array> {
    const waiter = this.waitFileStatus(expectedCmd, statusLabel, timeoutMs);
    await this.sendFrame(frame, writeLabel);
    return await waiter;
  }

  private async waitFileStatus(
    cmd: number,
    label: string,
    timeoutMs = 10_000,
  ): Promise<Uint8Array> {
    const body = await this.waitForFile(cmd, timeoutMs);
    const status = body.length >= 2 ? this.readU16le(body, 0) : null;

    if (status !== null && status !== 0) {
      throw new Error(
        `${label} failed: status=${status} body=${this.bytesToHex(body)}`,
      );
    }

    return body;
  }

  private async sendAndWaitControl(
    frame: Uint8Array,
    writeLabel: string,
    expectedCmd: number,
    timeoutMs = 10_000,
  ): Promise<Uint8Array> {
    const waiter = this.waitForControl(expectedCmd, timeoutMs);
    await this.sendFrame(frame, writeLabel);
    return await waiter;
  }

  private async waitDataAck(index: number): Promise<void> {
    const body = await this.waitForFile(
      this.FileCommand.FILE_SEND_DATA_RESPONSE,
      15_000,
    );

    const status = body.length >= 6 ? this.readU16le(body, 4) : 0;

    if (status !== 0) {
      throw new Error(`Chunk ${index} rejected: body=${this.bytesToHex(body)}`);
    }
  }

  private async sendAndWaitDataAck(
    frame: Uint8Array,
    index: number,
  ): Promise<void> {
    const waiter = this.waitDataAck(index);
    await this.sendFrame(frame, `FILE_SEND_DATA_REQUEST[${index}]`);
    await waiter;
  }

  public async upload(file: File): Promise<void> {
    this.emit("status", "Preparing upload");

    const raw = new Uint8Array(await file.arrayBuffer());
    const { transfer, alignedLen, crc } = this.prepareTransferBytes(raw);

    const fileChunkSize = 10_240;
    const chunks: Uint8Array[] = [];

    for (let i = 0; i < transfer.length; i += fileChunkSize) {
      chunks.push(transfer.slice(i, i + fileChunkSize));
    }

    const crcText = `0x${crc.toString(16).padStart(8, "0")}`;

    this.emit("uploadPrepare", {
      filename: file.name,
      rawBytes: raw.length,
      alignedBytes: alignedLen,
      transferBytes: transfer.length,
      crc: crcText,
      chunks: chunks.length,
    });

    this.emit("uploadProgress", {
      done: 0,
      total: chunks.length,
    });

    this.emit("status", "Starting transfer");

    await this.sendAndWaitFileStatus(
      this.encodeStart(transfer.length),
      "START_REQUEST",
      this.FileCommand.START_RESPONSE,
      "START_RESPONSE",
    );

    this.emit("status", "Sending file info");

    await this.sendAndWaitFileStatus(
      this.encodeFileInfo(chunks.length),
      "FILE_INFO_REQUEST",
      this.FileCommand.FILE_INFO_RESPONSE,
      "FILE_INFO_RESPONSE",
    );

    this.emit("status", "Sending file header");

    await this.sendAndWaitFileStatus(
      this.encodeFileSendStart(transfer.length, file.name),
      "FILE_SEND_START_REQUEST",
      this.FileCommand.FILE_SEND_START_RESPONSE,
      "FILE_SEND_START_RESPONSE",
    );

    this.emit("status", "Uploading chunks");

    for (let i = 0; i < chunks.length; i++) {
      await this.sendAndWaitDataAck(this.encodeFileData(i, chunks[i]), i);

      this.emit("uploadProgress", {
        done: i + 1,
        total: chunks.length,
      });

      await this.sleep(20);
    }

    this.emit("status", "Finalizing");

    await this.sendAndWaitFileStatus(
      this.encodeFileSendEnd(),
      "FILE_SEND_END_REQUEST",
      this.FileCommand.FILE_SEND_END_RESPONSE,
      "FILE_SEND_END_RESPONSE",
      5_000,
    );

    await this.sendAndWaitFileStatus(
      this.encodeTransferEnd(),
      "END_REQUEST",
      this.FileCommand.END_RESPONSE,
      "END_RESPONSE",
      5_000,
    );

    this.emit("status", "Upload complete");
    this.emit("uploadComplete", undefined);
  }

  public async readDeviceCardInfo(): Promise<string> {
    this.emit("cardStatus", "Reading");

    const body = await this.sendAndWaitControl(
      this.encodeReadCardInfo(),
      "READ_CARD_INFO",
      this.CardCommand.RESP_READ_CARD,
    );

    const text = this.decodeTextBody(body);

    this.emit("cardStatus", "Read complete");

    return text;
  }

  public async writeDeviceCardInfo(text: string): Promise<void> {
    this.emit("cardStatus", "Saving");

    const body = await this.sendAndWaitControl(
      this.encodeSetCardInfo(text),
      "SET_CARD_INFO",
      this.CardCommand.RESP_CARD_INFO,
    );

    this.assertControlStatusOk(body, "SET_CARD_INFO");

    this.emit("cardStatus", "Saved");
  }

  public async readCardsCount(): Promise<number> {
    const body = await this.sendAndWaitControl(
      this.encodeReadCardsCount(),
      "READ_CARDS_COUNT",
      this.CardCommand.RESP_CARDS_COUNT,
    );

    if (body.length >= 2) {
      return this.readU16le(body, 0);
    }

    if (body.length >= 1) {
      return body[0];
    }

    return 0;
  }

  public async readCardById(id: number): Promise<ReceivedCard> {
    const body = await this.sendAndWaitControl(
      this.encodeReadCardById(id),
      `READ_CARD_BY_ID ${id}`,
      this.CardCommand.RESP_CARD_BY_ID,
    );

    return {
      id,
      raw: body,
      rawHex: this.bytesToHex(body),
      text: this.decodeTextBody(body),
    };
  }

  public async deleteCardById(id: number): Promise<void> {
    const body = await this.sendAndWaitControl(
      this.encodeDeleteCard(id),
      `DELETE_CARD ${id}`,
      this.CardCommand.RESP_DELETE_CARD,
    );

    this.assertControlStatusOk(body, "DELETE_CARD");
  }

  public async syncReceivedCards(): Promise<ReceivedCard[]> {
    this.emit("cardsStatus", "Reading count");

    const count = await this.readCardsCount();
    const cards: ReceivedCard[] = [];

    this.emit("cardsStatus", `Device count: ${count}`);

    for (let id = count - 1; id >= 1; id--) {
      try {
        this.emit("cardsStatus", `Reading card ${id}`);
        cards.push(await this.readCardById(id));
      } catch (err) {
        console.warn(`Failed to read card ${id}`, err);
      }
    }

    this.emit("cardsStatus", `Loaded ${cards.length} cards`);

    return cards;
  }

  public async readDeviceSettings(): Promise<ControlSettings> {
    this.emit("settingsStatus", "Reading");

    const body = await this.sendAndWaitControl(
      this.encodeReadControlInfo(),
      "READ_CONTROL_INFO",
      this.ControlCommand.CONTROL_INFO_RESPONSE,
    );

    this.currentControlSettings = this.parseControlSettings(body);

    this.emit("settingsStatus", "Read complete");

    return this.currentControlSettings;
  }

  public async writeDeviceSettings(
    patch: Partial<Omit<ControlSettings, "rawBytes">>,
  ): Promise<ControlSettings> {
    this.emit("settingsStatus", "Saving");

    const base =
      this.currentControlSettings ?? (await this.readDeviceSettings());

    const next: ControlSettings = {
      ...base,
      ...patch,
      rawBytes: new Uint8Array(base.rawBytes),
    };

    const bytes = this.buildControlSettingsBytes(next);

    const body = await this.sendAndWaitControl(
      this.encodeWriteControlInfo(bytes),
      "WRITE_CONTROL_INFO",
      this.ControlCommand.CONTROL_INFO_RESPONSE,
    );

    this.assertControlStatusOk(body, "WRITE_CONTROL_INFO");

    this.currentControlSettings = this.parseControlSettings(bytes);

    this.emit("settingsStatus", "Saved");

    return this.currentControlSettings;
  }

  public async readCarouselSeconds(): Promise<number> {
    this.emit("carouselStatus", "Reading");

    const body = await this.sendAndWaitControl(
      this.encodeReadCarousel(),
      "READ_CAROUSEL",
      this.ControlCommand.RESP_CAROUSEL_RD,
    );

    const seconds = body.length >= 2 ? this.readU16le(body, 0) : 0;

    this.emit("carouselStatus", `Read: ${seconds}s`);

    return seconds;
  }

  public async writeCarouselSeconds(seconds: number): Promise<void> {
    const clamped = Math.max(0, Math.min(Number(seconds) || 0, 3600));

    this.emit("carouselStatus", "Saving");

    const body = await this.sendAndWaitControl(
      this.encodeSetCarousel(clamped),
      "SET_CAROUSEL",
      this.ControlCommand.RESP_CAROUSEL,
    );

    this.assertControlStatusOk(body, "SET_CAROUSEL");

    this.emit(
      "carouselStatus",
      clamped > 0 ? `Saved: ${clamped}s` : "Carousel disabled",
    );
  }

  private encodeControl(
    command: number,
    payload = new Uint8Array(),
  ): Uint8Array {
    return this.encodeFrame(
      this.CATEGORY_CONTROL,
      this.concatBytes(new Uint8Array(this.u16le(command)), payload),
    );
  }

  private encodeReadControlInfo(): Uint8Array {
    return this.encodeControl(
      this.ControlCommand.CONTROL_INFO,
      new Uint8Array([0x01]),
    );
  }

  private encodeWriteControlInfo(controlInfoBytes: Uint8Array): Uint8Array {
    if (controlInfoBytes.length !== 8) {
      throw new Error("controlInfoBytes must be exactly 8 bytes");
    }

    return this.encodeControl(
      this.ControlCommand.CONTROL_INFO,
      this.concatBytes(new Uint8Array([0x02]), controlInfoBytes),
    );
  }

  private encodeReadCarousel(): Uint8Array {
    return this.encodeControl(
      this.ControlCommand.READ_CAROUSEL,
      new Uint8Array([0x01]),
    );
  }

  private encodeSetCarousel(seconds: number): Uint8Array {
    const n = Math.max(0, Math.min(Number(seconds) || 0, 3600));

    return this.encodeControl(
      this.ControlCommand.SET_CAROUSEL,
      new Uint8Array(this.u16le(n)),
    );
  }

  private encodeSetCardInfo(text: string): Uint8Array {
    const bytes = new TextEncoder().encode(text).slice(0, 319);
    return this.encodeControl(this.CardCommand.SET_CARD_INFO, bytes);
  }

  private encodeReadCardInfo(): Uint8Array {
    return this.encodeControl(
      this.CardCommand.READ_CARD_INFO,
      new Uint8Array([0x01]),
    );
  }

  private encodeReadCardsCount(): Uint8Array {
    return this.encodeControl(
      this.CardCommand.READ_CARDS_COUNT,
      new Uint8Array([0x01]),
    );
  }

  private encodeReadCardById(id: number): Uint8Array {
    return this.encodeControl(
      this.CardCommand.READ_CARD_BY_ID,
      new Uint8Array([0x01, id & 0xff]),
    );
  }

  private encodeDeleteCard(id: number): Uint8Array {
    return this.encodeControl(
      this.CardCommand.DELETE_CARD,
      new Uint8Array([0x02, id & 0xff]),
    );
  }

  private encodeFrame(category: number, payload: Uint8Array): Uint8Array {
    return this.concatBytes(
      new Uint8Array([category, 0x00, ...this.u16le(payload.length)]),
      payload,
    );
  }

  private encodeFileMessage(
    command: number,
    payload = new Uint8Array(),
  ): Uint8Array {
    const inner = this.concatBytes(
      new Uint8Array([...this.u16le(command), ...this.u16le(payload.length)]),
      payload,
    );

    return this.encodeFrame(this.CATEGORY_FILE, inner);
  }

  private encodeStart(totalLength: number): Uint8Array {
    const payload = new Uint8Array([
      0x01,
      0x00,
      0x02,
      ...this.u32le(totalLength),
    ]);

    return this.encodeFileMessage(this.FileCommand.START_REQUEST, payload);
  }

  private encodeFileInfo(packetCount: number): Uint8Array {
    return this.encodeFileMessage(
      this.FileCommand.FILE_INFO_REQUEST,
      new Uint8Array(this.u32le(packetCount)),
    );
  }

  private encodeFileSendStart(
    totalLength: number,
    filename: string,
  ): Uint8Array {
    const nameBytes = new TextEncoder().encode(filename);

    const payload = this.concatBytes(
      new Uint8Array([
        ...this.u32le(totalLength),
        ...this.u16le(nameBytes.length),
      ]),
      nameBytes,
    );

    return this.encodeFileMessage(
      this.FileCommand.FILE_SEND_START_REQUEST,
      payload,
    );
  }

  private encodeFileData(index: number, chunk: Uint8Array): Uint8Array {
    return this.encodeFileMessage(
      this.FileCommand.FILE_SEND_DATA_REQUEST,
      this.concatBytes(new Uint8Array(this.u32le(index)), chunk),
    );
  }

  private encodeFileSendEnd(): Uint8Array {
    return this.encodeFileMessage(
      this.FileCommand.FILE_SEND_END_REQUEST,
      new Uint8Array([0x00, 0x00]),
    );
  }

  private encodeTransferEnd(): Uint8Array {
    return this.encodeFileMessage(this.FileCommand.END_REQUEST);
  }

  private encodeLoseCheckResponse(): Uint8Array {
    return this.encodeFileMessage(
      this.FileCommand.LOSE_CHECK_RESPONSE,
      new Uint8Array([0x00, 0x00]),
    );
  }

  private parseFileFrame(
    frame: Uint8Array,
  ): { cmd: number; body: Uint8Array } | null {
    const category = frame[0];
    const payloadLen = this.readU16le(frame, 2);
    const payload = frame.slice(4, 4 + payloadLen);

    if (category !== this.CATEGORY_FILE || payload.length < 2) {
      return null;
    }

    return {
      cmd: this.readU16le(payload, 0),
      body: payload.slice(2),
    };
  }

  private parseControlFrame(
    frame: Uint8Array,
  ): { cmd: number; body: Uint8Array } | null {
    const category = frame[0];
    const payloadLen = this.readU16le(frame, 2);
    const payload = frame.slice(4, 4 + payloadLen);

    if (category !== this.CATEGORY_CONTROL || payload.length < 2) {
      return null;
    }

    return {
      cmd: this.readU16le(payload, 0),
      body: payload.slice(2),
    };
  }

  private reassemble(data: Uint8Array): Uint8Array | null {
    const category = data[0];
    const type = data[1];

    if (type === 0) {
      return data;
    }

    if (type === 1) {
      this.reassembly.category = category;
      this.reassembly.expectedLen = this.readU16le(data, 2);
      this.reassembly.buffer = Array.from(data.slice(4));

      if (this.reassembly.buffer.length >= this.reassembly.expectedLen) {
        const payload = new Uint8Array(
          this.reassembly.buffer.slice(0, this.reassembly.expectedLen),
        );

        this.resetReassembly();

        return this.concatBytes(
          new Uint8Array([category, 0x00, ...this.u16le(payload.length)]),
          payload,
        );
      }

      return null;
    }

    if (type === 2 || type === 3) {
      if (
        this.reassembly.category !== category ||
        this.reassembly.expectedLen === null
      ) {
        this.resetReassembly();
        return null;
      }

      this.reassembly.buffer.push(...data.slice(2));

      if (type === 3) {
        const payload = new Uint8Array(
          this.reassembly.buffer.slice(0, this.reassembly.expectedLen),
        );

        this.resetReassembly();

        return this.concatBytes(
          new Uint8Array([category, 0x00, ...this.u16le(payload.length)]),
          payload,
        );
      }
    }

    return null;
  }

  private resetReassembly(): void {
    this.reassembly = {
      category: null,
      expectedLen: null,
      buffer: [],
    };
  }

  private splitFrame(frame: Uint8Array, mtu = 512): Uint8Array[] {
    const chunkSize = mtu - 3 - 4;
    const category = frame[0];
    const payload = frame.slice(4);
    const totalPayloadLen = payload.length;

    if (frame.length <= chunkSize) {
      return [frame];
    }

    const chunks: Uint8Array[] = [];

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const part = payload.slice(offset, offset + chunkSize);

      if (offset === 0) {
        chunks.push(
          this.concatBytes(
            new Uint8Array([category, 0x01, ...this.u16le(totalPayloadLen)]),
            part,
          ),
        );
      } else if (offset + part.length < payload.length) {
        chunks.push(this.concatBytes(new Uint8Array([category, 0x02]), part));
      } else {
        chunks.push(this.concatBytes(new Uint8Array([category, 0x03]), part));
      }
    }

    return chunks;
  }

  private parseControlSettings(bytes: Uint8Array): ControlSettings {
    const b = new Uint8Array(this.DEFAULT_CONTROL_INFO_BYTES);

    for (let i = 0; i < Math.min(bytes.length, 8); i++) {
      b[i] = bytes[i] & 0xff;
    }

    return {
      disableBroadcast: b[0] === 0,
      disableBuzzer: b[1] === 0,
      disableVibration: b[2] === 0,
      disableLight: b[3] === 0,
      disableInterestSensing: b[4] === 0,
      disableAmbienceLight: b[5] === 0,
      rawBytes: b,
    };
  }

  private buildControlSettingsBytes(settings: ControlSettings): Uint8Array {
    const b = new Uint8Array(
      settings.rawBytes || this.DEFAULT_CONTROL_INFO_BYTES,
    );

    b[0] = settings.disableBroadcast ? 0 : 1;
    b[1] = settings.disableBuzzer ? 0 : 1;
    b[2] = settings.disableVibration ? 0 : 1;
    b[3] = settings.disableLight ? 0 : 1;
    b[4] = settings.disableInterestSensing ? 0 : 1;
    b[5] = settings.disableAmbienceLight ? 0 : 1;

    return b;
  }

  private prepareTransferBytes(raw: Uint8Array): {
    transfer: Uint8Array;
    alignedLen: number;
    crc: number;
  } {
    const alignedLen = (raw.length + 3) & ~3;
    const padded = new Uint8Array(alignedLen);

    padded.set(raw);

    const crc = this.monicardCrc32(padded);
    const transfer = this.concatBytes(padded, new Uint8Array(this.u32le(crc)));

    return { transfer, alignedLen, crc };
  }

  private monicardCrc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    const poly = 0x04c11db7;

    for (const b of data) {
      crc ^= (b << 24) >>> 0;

      for (let i = 0; i < 8; i++) {
        if (crc & 0x80000000) {
          crc = (((crc << 1) >>> 0) ^ poly) >>> 0;
        } else {
          crc = (crc << 1) >>> 0;
        }
      }
    }

    return crc >>> 0;
  }

  private assertControlStatusOk(body: Uint8Array, label: string): void {
    const status = body.length >= 2 ? this.readU16le(body, 0) : null;

    if (status !== null && status !== 0) {
      throw new Error(
        `${label} failed: status=${status} body=${this.bytesToHex(body)}`,
      );
    }
  }

  private decodeTextBody(body: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: false })
      .decode(body)
      .replace(/\0+$/, "")
      .trim();
  }

  private concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const len = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(len);

    let offset = 0;

    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }

    return out;
  }

  private u16le(n: number): number[] {
    return [n & 0xff, (n >> 8) & 0xff];
  }

  private u32le(n: number): number[] {
    return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  }

  private readU16le(bytes: Uint8Array, offset = 0): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  private readU32le(bytes: Uint8Array, offset = 0): number {
    return (
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0
    );
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const bluetoothService = new BluetoothService();
