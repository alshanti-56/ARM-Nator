import type { PlayerPictureSettings } from './player-controls.model';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
let nextFilterId = 0;

/** Applies the shared picture model to a browser-backed video element. */
export class WebVideoPictureAdjustments {
    private readonly filterId = `arm-nator-picture-${nextFilterId++}`;
    private readonly svg: SVGSVGElement;
    private readonly transfer: SVGFEComponentTransferElement;
    private readonly saturation: SVGFEColorMatrixElement;

    constructor(private readonly video: HTMLVideoElement) {
        const document = video.ownerDocument;
        this.svg = document.createElementNS(SVG_NAMESPACE, 'svg');
        this.svg.setAttribute('width', '0');
        this.svg.setAttribute('height', '0');
        this.svg.style.position = 'absolute';
        this.svg.style.pointerEvents = 'none';
        this.svg.style.opacity = '0';

        const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
        const filter = document.createElementNS(SVG_NAMESPACE, 'filter');
        filter.setAttribute('id', this.filterId);
        const transfer = document.createElementNS(
            SVG_NAMESPACE,
            'feComponentTransfer'
        );
        for (const channelName of ['feFuncR', 'feFuncG', 'feFuncB']) {
            const channel = document.createElementNS(
                SVG_NAMESPACE,
                channelName
            );
            channel.setAttribute('type', 'gamma');
            transfer.appendChild(channel);
        }
        const saturation = document.createElementNS(
            SVG_NAMESPACE,
            'feColorMatrix'
        );
        saturation.setAttribute('type', 'saturate');
        filter.append(transfer, saturation);
        defs.appendChild(filter);
        this.svg.appendChild(defs);
        (document.body ?? document.documentElement).appendChild(this.svg);
        this.transfer = transfer;
        this.saturation = saturation;
    }

    apply(settings: PlayerPictureSettings): void {
        const brightness = 1 + settings.brightness / 100;
        const contrast = 1 + settings.contrast / 100;
        const blackLevel = settings.blackLevel / 400;
        const gamma = Math.max(0.1, 1 + settings.gamma / 100);
        for (const channel of Array.from(this.transfer.children)) {
            channel.setAttribute('amplitude', String(brightness));
            channel.setAttribute('exponent', String(gamma));
            channel.setAttribute('offset', String(blackLevel));
            channel.setAttribute('slope', String(contrast));
        }
        this.saturation.setAttribute(
            'values',
            String(Math.max(0, 1 + settings.saturation / 100))
        );
        this.video.style.filter = `url("#${this.filterId}")`;
    }

    destroy(): void {
        this.video.style.removeProperty('filter');
        this.svg.remove();
    }
}
