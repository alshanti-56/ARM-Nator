export class IpcCommand {
    constructor(
        public id: string,
        public callback: (payload?: unknown) => void
    ) {
        this.id = id;
        this.callback = callback;
    }
}
