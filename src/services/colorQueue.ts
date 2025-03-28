export class ColorQueue {
    private indexes: number[];
    private isRandom: boolean;
    private usedIndexes: Set<number>;
    private originalOrder: number[];
    private isReversedSequential: boolean;
    private recentlyUsed: number[];

    constructor(length: number, isRandom: boolean = false, isReversedSequential: boolean = false) {
        this.originalOrder = Array.from({ length }, (_, i) => i);

        if (!isRandom && isReversedSequential) {
            this.indexes = [...this.originalOrder].reverse();
        } else {
            this.indexes = [...this.originalOrder];
        }

        this.isRandom = isRandom;
        this.isReversedSequential = isReversedSequential;
        this.usedIndexes = new Set<number>();
        this.recentlyUsed = [];

        if (isRandom) {
            this.indexes = shuffleArray([...this.indexes]);
        }
    }

    public getNextIndex(): number {
        if (this.indexes.length === 0) {
            if (this.isRandom) {
                const availableIndices = this.originalOrder.filter((idx) => !this.recentlyUsed.includes(idx));

                if (availableIndices.length > 0) {
                    this.indexes = shuffleArray([...availableIndices]);
                } else {
                    this.indexes = shuffleArray([...this.originalOrder]);
                    this.recentlyUsed = [];
                }
            } else if (this.isReversedSequential) {
                return this.originalOrder[this.originalOrder.length - 1];
            } else {
                return this.originalOrder[0];
            }
        }

        const index = this.indexes.shift();

        if (index === undefined) {
            return 0;
        }

        this.usedIndexes.add(index);

        this.recentlyUsed.push(index);

        const historyLength = Math.max(1, Math.floor(this.originalOrder.length / 3));
        if (this.recentlyUsed.length > historyLength) {
            this.recentlyUsed.shift();
        }

        return index;
    }

    public releaseIndex(index: number): void {
        this.usedIndexes.delete(index);

        const recentlyUsedIndex = this.recentlyUsed.indexOf(index);
        if (recentlyUsedIndex !== -1) {
            this.recentlyUsed.splice(recentlyUsedIndex, 1);
        }

        if (!this.isRandom) {
            if (this.isReversedSequential) {
                let inserted = false;
                for (let i = 0; i < this.indexes.length; i++) {
                    if (index > this.indexes[i]) {
                        this.indexes.splice(i, 0, index);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) {
                    this.indexes.push(index);
                }
            } else {
                let inserted = false;
                for (let i = 0; i < this.indexes.length; i++) {
                    if (index < this.indexes[i]) {
                        this.indexes.splice(i, 0, index);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) {
                    this.indexes.push(index);
                }
            }
        } else {
            const minPosition = Math.min(1, this.indexes.length);
            const maxPosition = this.indexes.length;
            if (maxPosition > 0) {
                const position = minPosition + Math.floor(Math.random() * (maxPosition - minPosition));
                this.indexes.splice(position, 0, index);
            } else {
                this.indexes.push(index);
            }
        }
    }

    public setRandom(isRandom: boolean): void {
        if (this.isRandom !== isRandom) {
            this.isRandom = isRandom;

            const availableIndexes = this.originalOrder.filter((idx) => !this.usedIndexes.has(idx));

            if (isRandom) {
                this.indexes = shuffleArray([...availableIndexes]);
            } else {
                if (this.isReversedSequential) {
                    this.indexes = [...availableIndexes].sort((a, b) => b - a);
                } else {
                    this.indexes = [...availableIndexes].sort((a, b) => a - b);
                }
            }

            this.recentlyUsed = [];
        }
    }

    public setReversedSequential(isReversed: boolean): void {
        if (this.isReversedSequential !== isReversed) {
            this.isReversedSequential = isReversed;

            if (!this.isRandom) {
                const availableIndexes = [...this.indexes];

                if (isReversed) {
                    this.indexes = availableIndexes.sort((a, b) => b - a);
                } else {
                    this.indexes = availableIndexes.sort((a, b) => a - b);
                }
            }

            this.recentlyUsed = [];
        }
    }

    public getIndexes(): number[] {
        return [...this.indexes];
    }

    public setIndexes(indexes: number[]): void {
        this.indexes = [...indexes];

        this.usedIndexes.clear();
        this.recentlyUsed = [];

        for (let i = 0; i < this.originalOrder.length; i++) {
            const idx = this.originalOrder[i];
            if (!this.indexes.includes(idx)) {
                this.usedIndexes.add(idx);
            }
        }
    }
}

function shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
