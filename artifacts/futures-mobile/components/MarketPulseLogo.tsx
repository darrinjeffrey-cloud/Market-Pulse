import React from 'react';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';

export default function MarketPulseLogo() {
  return (
    <Svg width={180} height={150} viewBox="0 0 360 300" fill="none" accessibilityLabel="Market Pulse logo">
      <Rect width="360" height="300" rx="48" fill="#100D08" />
      <Rect x="2" y="2" width="356" height="296" rx="46" stroke="#F5A800" strokeOpacity={0.55} strokeWidth="4" />
      <Path
        d="M32 126H76L91 126L110 74L132 190L153 113L175 146L202 105L227 132L289 49"
        stroke="#F5A800"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M289 49L258 57M289 49L282 81"
        stroke="#F5A800"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx="289" cy="49" r="7" fill="#F5A800" />
      <SvgText
        x="180"
        y="247"
        textAnchor="middle"
        fill="#F5A800"
        fontFamily="Arial"
        fontSize="30"
        fontWeight="800"
        letterSpacing="1"
      >
        MARKET PULSE
      </SvgText>
    </Svg>
  );
}