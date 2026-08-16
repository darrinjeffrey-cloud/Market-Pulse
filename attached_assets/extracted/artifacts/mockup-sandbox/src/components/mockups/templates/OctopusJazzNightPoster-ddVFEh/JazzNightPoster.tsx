import React from 'react';
import jazzOctopusTrumpet from './images/jazz-octopus-trumpet.png';

export default function JazzNightPoster() {
  return (
    <div 
      className="relative w-[640px] h-[900px] bg-[#f6f0e4] overflow-hidden flex flex-col font-hand text-[#111]"
      style={{
        boxShadow: 'inset 0 0 100px rgba(0,0,0,0.03)'
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Shantell+Sans:ital,wght@0,300..800;1,300..800&family=Caveat:wght@700&display=swap');
        
        .font-hand {
          font-family: 'Shantell Sans', cursive;
        }
        .font-script {
          font-family: 'Caveat', cursive;
        }
      `}</style>

      {/* Background Checkerboard Frame */}
      <div 
        className="absolute inset-0 z-0" 
        style={{
          backgroundColor: '#f6f0e4',
          backgroundImage: 'conic-gradient(#111 90deg, transparent 90deg 180deg, #111 180deg 270deg, transparent 270deg)',
          backgroundSize: '40px 40px'
        }} 
      />
      {/* Inner Cream Canvas */}
      <div className="absolute inset-[20px] bg-[#f6f0e4] z-0 border-[4px] border-[#111]" />

      {/* The Illustration */}
      <div 
        className="absolute inset-[24px] z-10 pointer-events-none mix-blend-multiply"
        style={{
          backgroundImage: `url(${jazzOctopusTrumpet})`,
          backgroundSize: '90%',
          backgroundPosition: 'calc(50% + 10px) 95%',
          backgroundRepeat: 'no-repeat',
          filter: 'grayscale(100%) contrast(200%)',
          opacity: 0.95
        }}
      />
      
      {/* Top Arc - JAZZ */}
      <svg className="absolute inset-0 z-20 pointer-events-none" viewBox="0 0 640 900">
        <defs>
          <path id="jazz-arc" d="M 80 275 Q 320 110 560 275" />
          <path id="night-arc" d="M 170 365 Q 320 250 470 365" />
        </defs>
        <text className="font-hand font-extrabold" fill="#111" fontSize="130" style={{ letterSpacing: '2px' }}>
          <textPath href="#jazz-arc" startOffset="50%" textAnchor="middle">
            JAZZ
          </textPath>
        </text>
        <text className="font-hand font-extrabold" fill="#111" fontSize="85" style={{ letterSpacing: '4px' }}>
          <textPath href="#night-arc" startOffset="50%" textAnchor="middle">
            NIGHT
          </textPath>
        </text>
      </svg>
      
      {/* Left Outer - TRIESTE */}
      <div className="absolute left-[35px] top-[290px] flex flex-col text-[60px] font-hand font-extrabold leading-[0.85] text-[#111] z-20 items-center">
        <span style={{ transform: 'rotate(-6deg) translateX(0px)' }}>T</span>
        <span style={{ transform: 'rotate(4deg) translateX(5px)' }}>R</span>
        <span style={{ transform: 'rotate(-2deg) translateX(0px)' }}>I</span>
        <span style={{ transform: 'rotate(5deg) translateX(-5px)' }}>E</span>
        <span style={{ transform: 'rotate(-7deg) translateX(-5px)' }}>S</span>
        <span style={{ transform: 'rotate(3deg) translateX(0px)' }}>T</span>
        <span style={{ transform: 'rotate(-4deg) translateX(5px)' }}>E</span>
      </div>

      {/* Left Inner - CAFFÈ */}
      <div className="absolute left-[100px] top-[345px] flex flex-col text-[50px] font-hand font-extrabold leading-[0.85] text-[#111] z-20 items-center">
        <span style={{ transform: 'rotate(5deg) translateX(10px)' }}>C</span>
        <span style={{ transform: 'rotate(-5deg) translateX(5px)' }}>A</span>
        <span style={{ transform: 'rotate(3deg) translateX(0px)' }}>F</span>
        <span style={{ transform: 'rotate(-6deg) translateX(-5px)' }}>F</span>
        <span style={{ transform: 'rotate(4deg) translateX(-15px)' }}>È</span>
      </div>

      {/* Tiny Address Block */}
      <div className="absolute right-[45px] bottom-[55px] z-20 text-right font-script text-[26px] leading-[1.1] font-bold opacity-90" style={{ transform: 'rotate(-3deg)' }}>
        601 Vallejo St.<br/>
        North Beach, S.F.<br/>
        Nov 7 <span className="font-sans align-middle text-[0.8em] px-1">•</span> 8 PM
      </div>
    </div>
  );
}

