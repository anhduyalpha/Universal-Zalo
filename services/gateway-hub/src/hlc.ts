export interface HlcTimestamp {
  physicalTime: number;
  logicalCounter: number;
}

export class HybridLogicalClock {
  private lastPhysicalTime: number;
  private logicalCounter: number;

  constructor() {
    this.lastPhysicalTime = Date.now();
    this.logicalCounter = 0;
  }

  public now(): HlcTimestamp {
    const physical = Date.now();
    if (physical > this.lastPhysicalTime) {
      this.lastPhysicalTime = physical;
      this.logicalCounter = 0;
    } else {
      this.logicalCounter += 1;
    }

    return {
      physicalTime: this.lastPhysicalTime,
      logicalCounter: this.logicalCounter,
    };
  }

  public update(remote: HlcTimestamp): HlcTimestamp {
    const physical = Date.now();
    const maxPhysical = Math.max(physical, this.lastPhysicalTime, remote.physicalTime);

    if (maxPhysical === this.lastPhysicalTime && maxPhysical === remote.physicalTime) {
      this.logicalCounter = Math.max(this.logicalCounter, remote.logicalCounter) + 1;
    } else if (maxPhysical === this.lastPhysicalTime) {
      this.logicalCounter += 1;
    } else if (maxPhysical === remote.physicalTime) {
      this.logicalCounter = remote.logicalCounter + 1;
    } else {
      this.logicalCounter = 0;
    }

    this.lastPhysicalTime = maxPhysical;
    return {
      physicalTime: this.lastPhysicalTime,
      logicalCounter: this.logicalCounter,
    };
  }

  public static compare(a: HlcTimestamp, b: HlcTimestamp): number {
    if (a.physicalTime !== b.physicalTime) {
      return a.physicalTime - b.physicalTime;
    }
    return a.logicalCounter - b.logicalCounter;
  }
}
