// Plays the voice call's join/leave sounds (src/call/cues.ts), given as a
// small WAV. It leaves the audio session alone: WebRTC's call session is
// already active, so the sound plays into the call on its current route
// (speaker, earpiece or headset) without interrupting it.

#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>

@interface CallCueModule : NSObject <RCTBridgeModule, AVAudioPlayerDelegate>
@end

@implementation CallCueModule {
  // Players stay alive until they finish (AVAudioPlayer stops when released).
  NSMutableSet<AVAudioPlayer *> *_playing;
}

RCT_EXPORT_MODULE(CallCue)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if ((self = [super init])) _playing = [NSMutableSet set];
  return self;
}

RCT_EXPORT_METHOD(play:(NSString *)wavBase64)
{
  NSData *wav = [[NSData alloc] initWithBase64EncodedString:wavBase64 options:0];
  if (!wav) return;
  AVAudioPlayer *player = [[AVAudioPlayer alloc] initWithData:wav error:nil];
  if (!player) return;
  player.delegate = self;
  @synchronized(_playing) {
    [_playing addObject:player];
  }
  if (![player play]) {
    @synchronized(_playing) {
      [_playing removeObject:player];
    }
  }
}

- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag
{
  @synchronized(_playing) {
    [_playing removeObject:player];
  }
}

@end
