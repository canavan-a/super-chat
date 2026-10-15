import React from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  File,
  HeadphoneOff,
  Headphones,
  Info,
  Link,
  Lock,
  LucideIcon,
  Mic,
  MicOff,
  MoreVertical,
  Plus,
  Paperclip,
  PhoneOff,
  RefreshCw,
  Reply,
  Send,
  Settings,
  Shield,
  SignalLow,
  SmilePlus,
  Speaker,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';

// lucide-react-native is the icon set used everywhere in the app, the same
// one super-badger uses, so both apps draw icons the same way. It renders
// through react-native-svg, whose web resolution is fixed in vite.config.ts.
export type IconName =
  | 'kebab'
  | 'gear'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'trash'
  | 'close'
  | 'check'
  | 'copy'
  | 'send'
  | 'reply'
  | 'react'
  | 'attach'
  | 'file'
  | 'download'
  | 'invite'
  | 'members'
  | 'shield'
  | 'lock'
  | 'link'
  | 'plus'
  | 'headphones'
  | 'headphone-off'
  | 'phone-off'
  | 'mic'
  | 'mic-off'
  | 'volume-2'
  | 'volume-x'
  | 'speaker'
  | 'info'
  | 'warning'
  | 'retry'
  | 'signal-low';

const ICONS: Record<IconName, LucideIcon> = {
  kebab: MoreVertical,
  gear: Settings,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  trash: Trash2,
  close: X,
  check: Check,
  copy: Copy,
  send: Send,
  reply: Reply,
  react: SmilePlus,
  attach: Paperclip,
  file: File,
  download: Download,
  invite: UserPlus,
  members: Users,
  shield: Shield,
  lock: Lock,
  link: Link,
  plus: Plus,
  headphones: Headphones,
  'headphone-off': HeadphoneOff,
  'phone-off': PhoneOff,
  mic: Mic,
  'mic-off': MicOff,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  speaker: Speaker,
  info: Info,
  warning: TriangleAlert,
  retry: RefreshCw,
  'signal-low': SignalLow,
};

export function Icon({
  name,
  size = 20,
  color = '#000',
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const IconComponent = ICONS[name];
  return <IconComponent size={size} color={color} strokeWidth={strokeWidth} fill="none" />;
}
