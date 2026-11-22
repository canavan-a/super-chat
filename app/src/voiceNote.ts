// Recording a voice message on Android and iOS: AAC in an MP4 container
// (.m4a), mono, 64 kbps, which every platform plays, about 0.5 MB a minute.
// The recording is read into memory and its file deleted as soon as it stops.
import {PermissionsAndroid, Platform} from 'react-native';
import AudioRecorderPlayer, {
  AudioEncoderAndroidType,
  AudioSourceAndroidType,
  AVEncoderAudioQualityIOSType,
  AVEncodingOption,
  OutputFormatAndroidType,
} from 'react-native-audio-recorder-player';
import RNFS from 'react-native-fs';

import {readFileChunked} from './chunkedFs';
import type {PickedFile} from './files';
import {dbToLevel, toBars} from './voiceWave';

export interface VoiceRecording {
  /** Stops and hands back the recording; null if it was too short to keep. */
  stop(): Promise<PickedFile | null>;
  /** Stops and throws it away. */
  cancel(): void;
}

const recorder = new AudioRecorderPlayer();
let busy = false;

async function allowed(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS asks by itself, from NSMicrophoneUsageDescription
  const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

const pathOf = (uri: string) => decodeURI(uri.replace('file://', ''));

/** Starts recording. onLevel gets the loudness (0–1) and seconds so far, ten times a second. */
export async function startVoiceNote(onLevel: (level: number, seconds: number) => void): Promise<VoiceRecording> {
  if (busy) throw new Error('Already recording.');
  if (!(await allowed())) throw new Error('Super Chat needs microphone access: allow it in Settings.');
  busy = true;
  const levels: number[] = [];
  let seconds = 0;
  let uri = '';
  try {
    await recorder.setSubscriptionDuration(0.1);
    recorder.addRecordBackListener(e => {
      seconds = e.currentPosition / 1000;
      const level = dbToLevel(e.currentMetering ?? -160);
      levels.push(level);
      onLevel(level, seconds);
    });
    uri = await recorder.startRecorder(
      undefined,
      {
        AudioSourceAndroid: AudioSourceAndroidType.MIC,
        OutputFormatAndroid: OutputFormatAndroidType.MPEG_4,
        AudioEncoderAndroid: AudioEncoderAndroidType.AAC,
        AudioEncodingBitRateAndroid: 64000,
        AudioSamplingRateAndroid: 44100,
        AudioChannelsAndroid: 1,
        AVFormatIDKeyIOS: AVEncodingOption.aac,
        AVNumberOfChannelsKeyIOS: 1,
        AVSampleRateKeyIOS: 44100,
        AVEncoderBitRateKeyIOS: 64000,
        AVEncoderAudioQualityKeyIOS: AVEncoderAudioQualityIOSType.medium,
      },
      true,
    );
  } catch (e) {
    recorder.removeRecordBackListener();
    busy = false;
    throw new Error(`Couldn't start recording: ${(e as Error).message ?? e}`);
  }

  const finish = async (): Promise<string> => {
    recorder.removeRecordBackListener();
    try {
      return pathOf((await recorder.stopRecorder()) || uri);
    } finally {
      busy = false;
    }
  };
  return {
    async stop() {
      const path = await finish();
      try {
        if (seconds < 0.7) return null;
        const data = await readFileChunked(path);
        return {name: 'Voice message.m4a', mime: 'audio/mp4', data, dur: Math.round(seconds), wave: toBars(levels)};
      } finally {
        RNFS.unlink(path).catch(() => {});
      }
    },
    cancel() {
      finish()
        .then(path => RNFS.unlink(path))
        .catch(() => {});
    },
  };
}
