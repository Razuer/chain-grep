export class ColorQueue {
    private indexes: number[];
    private isRandom: boolean;

    constructor(length: number, isRandom: boolean = false) {
        this.indexes = Array.from({ length }, (_, i) => i);
        this.isRandom = isRandom;

        if (isRandom) {
            this.indexes = shuffleArray([...this.indexes]);
        }
    }

    public getNextIndex(): number {
        // Get the first index from the queue
        const index = this.indexes.shift();

        if (index === undefined) {
            return 0; // Shouldn't happen, but just in case
        }

        // Put the index at the end of the queue
        this.indexes.push(index);

        return index;
    }

    // Add a new method to handle releasing an index
    public releaseIndex(index: number): void {
        // Find and remove the index from wherever it is in the queue
        const indexPosition = this.indexes.indexOf(index);
        if (indexPosition >= 0) {
            this.indexes.splice(indexPosition, 1);
        }

        // For non-random mode (sequential colors), released indexes go to the front
        // This ensures the same color will be assigned next time
        if (!this.isRandom) {
            this.indexes.unshift(index);
        } else {
            // For random mode, released indexes go to the back of the queue
            this.indexes.push(index);
        }
    }

    public setRandom(isRandom: boolean): void {
        if (this.isRandom !== isRandom) {
            this.isRandom = isRandom;

            // Create a fresh set of indexes
            const length = this.indexes.length;
            this.indexes = Array.from({ length }, (_, i) => i);

            if (isRandom) {
                this.indexes = shuffleArray([...this.indexes]);
            }
        }
    }

    public getIndexes(): number[] {
        return [...this.indexes];
    }

    public setIndexes(indexes: number[]): void {
        this.indexes = [...indexes];
    }
}

function shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
