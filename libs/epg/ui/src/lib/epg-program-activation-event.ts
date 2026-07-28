import type { EpgProgram } from '@arm-nator/shared/interfaces';

export interface EpgProgramActivationEvent {
    program: EpgProgram;
    type: 'live' | 'timeshift';
}
