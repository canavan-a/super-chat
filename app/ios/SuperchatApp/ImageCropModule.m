// Cuts the square the user framed in the profile-picture cropper out of an
// image and scales it to the final size, as a JPEG: the iOS twin of
// android/…/ImageCropModule.kt, with the same crop(base64, x, y, size, out).
// Everything stays in memory (base64 in, base64 out): no decoded copy of the
// photo is written anywhere.

#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

@interface ImageCropModule : NSObject <RCTBridgeModule>
@end

@implementation ImageCropModule

RCT_EXPORT_MODULE(ImageCrop)

- (dispatch_queue_t)methodQueue
{
  return dispatch_queue_create("com.superchatapp.ImageCrop", DISPATCH_QUEUE_SERIAL);
}

/** Crops the square at (x, y) of side size (source pixels) and scales it to out×out. */
RCT_EXPORT_METHOD(crop:(NSString *)base64
                  x:(double)x
                  y:(double)y
                  size:(double)size
                  out:(NSInteger)out
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  @autoreleasepool {
    NSData *bytes = [[NSData alloc] initWithBase64EncodedString:base64
                                                        options:NSDataBase64DecodingIgnoreUnknownCharacters];
    // The picker re-encodes photos upright, so the CGImage's pixels are
    // already in display orientation.
    CGImageRef src = bytes ? [UIImage imageWithData:bytes].CGImage : NULL;
    if (!src || out < 1) {
      reject(@"E_CROP", @"Couldn't read that image.", nil);
      return;
    }
    size_t w = CGImageGetWidth(src), h = CGImageGetHeight(src);
    double side = MAX(1, MIN(size, (double)MIN(w, h)));
    double left = MAX(0, MIN(x, w - side));
    double top = MAX(0, MIN(y, h - side));
    CGImageRef cut = CGImageCreateWithImageInRect(src, CGRectMake(floor(left), floor(top), floor(side), floor(side)));
    if (!cut) {
      reject(@"E_CROP", @"Couldn't crop that image.", nil);
      return;
    }
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
    format.scale = 1;
    format.opaque = YES;
    UIGraphicsImageRenderer *renderer =
        [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(out, out) format:format];
    NSData *jpeg = [renderer JPEGDataWithCompressionQuality:0.85
                                                    actions:^(UIGraphicsImageRendererContext *ctx) {
      [[UIImage imageWithCGImage:cut] drawInRect:CGRectMake(0, 0, out, out)];
    }];
    CGImageRelease(cut);
    resolve([jpeg base64EncodedStringWithOptions:0]);
  }
}

@end
