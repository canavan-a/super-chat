// Push for iOS (src/push.ts), the twin of the Google Play build's
// android/…/PushModule.kt: the device subscribes itself to its rooms' FCM
// topics, so the chat server never sees a device token. FCM hands the
// wake-ups to APNs.
//
// A wake-up is a plain "New message" alert that iOS shows by itself while
// the app is in the background (server/push). While the app is open it's
// swallowed here and passed to JS as "PushWake", which fetches and
// decrypts the room and shows the real notification.

#import <React/RCTEventEmitter.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <FirebaseCore/FirebaseCore.h>
#import <FirebaseMessaging/FirebaseMessaging.h>

/** Groups the plain alerts, so clearLocked can remove just those (server/push: thread-id). */
static NSString *const kWakeThread = @"sc-wake";

@interface PushModule : RCTEventEmitter <RCTBridgeModule>
- (void)wake:(NSString *)topic;
/** Whether JS is listening for wake-ups (it is once the app is unlocked). */
- (BOOL)listening;
@end

/**
 * The notification center's delegate for wake-ups. Installed before launch
 * finishes, so Notifee (which takes over as the delegate at launch) keeps it
 * and forwards every notification it didn't create itself.
 */
@interface PushCenterDelegate : NSObject <UNUserNotificationCenterDelegate>
@property (nonatomic, weak) PushModule *module;
@end

@implementation PushCenterDelegate

+ (instancetype)shared
{
  static PushCenterDelegate *shared;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [PushCenterDelegate new];
  });
  return shared;
}

+ (void)load
{
  [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidFinishLaunchingNotification
                                                    object:nil
                                                     queue:nil
                                                usingBlock:^(NSNotification *note) {
    if ([FIRApp defaultApp] == nil) [FIRApp configure];
  }];
  [UNUserNotificationCenter currentNotificationCenter].delegate = [PushCenterDelegate shared];
}

// App open: no banner for a wake-up, the app shows the room's own
// notification. Unless JS isn't listening yet (still locked, say): then the
// plain alert shows, rather than nothing at all.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler
{
  NSString *topic = notification.request.content.userInfo[@"t"];
  PushModule *module = self.module;
  if ([topic isKindOfClass:[NSString class]] && module.listening) {
    [module wake:topic];
    completionHandler(UNNotificationPresentationOptionNone);
  } else {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound | UNNotificationPresentationOptionList);
  }
}

// A tapped "New message" opens the app, which catches up by itself.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler
{
  completionHandler();
}

@end

@implementation PushModule {
  BOOL _listening;
}

RCT_EXPORT_MODULE(Push)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"PushWake" ];
}

- (void)startObserving
{
  _listening = YES;
  [PushCenterDelegate shared].module = self;
}

- (void)stopObserving
{
  _listening = NO;
}

- (void)wake:(NSString *)topic
{
  if (_listening) [self sendEventWithName:@"PushWake" body:@{@"topic" : topic}];
}

- (BOOL)listening
{
  return _listening;
}

/** Asks for permission to notify (once; iOS remembers the answer), then registers with APNs. */
RCT_EXPORT_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  UNAuthorizationOptions options = UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:options
                    completionHandler:^(BOOL granted, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [[UIApplication sharedApplication] registerForRemoteNotifications];
    });
    resolve(@(granted));
  }];
}

// Firebase keeps topic changes made before the APNs token arrives, and
// applies them once it does.
RCT_EXPORT_METHOD(subscribe:(NSString *)topic resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [[FIRMessaging messaging] subscribeToTopic:topic completion:^(NSError *error) {
    if (error) reject(@"push", error.localizedDescription ?: @"subscribe failed", error);
    else resolve(nil);
  }];
}

RCT_EXPORT_METHOD(unsubscribe:(NSString *)topic resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [[FIRMessaging messaging] unsubscribeFromTopic:topic completion:^(NSError *error) {
    if (error) reject(@"push", error.localizedDescription ?: @"unsubscribe failed", error);
    else resolve(nil);
  }];
}

/** Removes the plain "New message" alerts shown while the app was closed. */
RCT_EXPORT_METHOD(clearLocked)
{
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *delivered) {
    NSMutableArray<NSString *> *ids = [NSMutableArray new];
    for (UNNotification *n in delivered) {
      if ([n.request.content.threadIdentifier isEqualToString:kWakeThread]) [ids addObject:n.request.identifier];
    }
    if (ids.count) [center removeDeliveredNotificationsWithIdentifiers:ids];
  }];
}

@end
