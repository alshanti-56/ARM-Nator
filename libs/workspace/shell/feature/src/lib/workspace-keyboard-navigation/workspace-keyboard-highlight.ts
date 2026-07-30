export class WorkspaceKeyboardHighlight {
    private readonly ring = document.createElement('div');
    private target: HTMLElement | null = null;

    constructor() {
        Object.assign(this.ring.style, {
            position: 'fixed',
            display: 'none',
            pointerEvents: 'none',
            zIndex: '1100',
            border: '4px solid #8ea7ff',
            borderRadius: '10px',
            background: 'rgba(142, 167, 255, 0.12)',
            boxShadow: '0 0 0 2px #11151d, 0 0 18px rgba(142, 167, 255, 0.9)',
            boxSizing: 'border-box',
        });
        this.ring.setAttribute('aria-hidden', 'true');
        document.body.appendChild(this.ring);
        window.addEventListener('resize', this.refresh);
        document.addEventListener('scroll', this.refresh, true);
    }

    show(target: HTMLElement): void {
        this.target = target;
        this.refresh();
    }

    hide(): void {
        this.target = null;
        this.ring.style.display = 'none';
    }

    destroy(): void {
        window.removeEventListener('resize', this.refresh);
        document.removeEventListener('scroll', this.refresh, true);
        this.ring.remove();
    }

    private readonly refresh = (): void => {
        if (!this.target?.isConnected) {
            this.ring.style.display = 'none';
            return;
        }
        const rect = this.target.getBoundingClientRect();
        Object.assign(this.ring.style, {
            display: rect.width > 0 && rect.height > 0 ? 'block' : 'none',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            borderRadius: getComputedStyle(this.target).borderRadius || '10px',
        });
    };
}
