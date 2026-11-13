import { Cat, Flower, MoonStar, PawPrint, Sparkles } from 'lucide-react';

// Geometric ribbon pieces keep this ornament local, scalable and decorative.
export function RibbonBow({ className = '' }) {
  return <span className={'ribbon-bow ' + className} aria-hidden="true">
    <span className="bow-tail bow-tail-left"/><span className="bow-tail bow-tail-right"/>
    <span className="bow-loop bow-loop-left"/><span className="bow-loop bow-loop-right"/>
    <span className="bow-knot"/>
  </span>;
}

export function LaceDivider({ className = '' }) {
  return <div className={'lace-divider ' + className} aria-hidden="true">
    <span className="lace-rail"/>
    <span className="lace-weave"><Flower/><span className="lace-eyelet"/><Flower className="lace-flower-center"/><span className="lace-eyelet"/><Flower/></span>
    <span className="lace-rail"/>
  </div>;
}

export function PawTrail({ className = '' }) {
  return <span className={'paw-trail ' + className} aria-hidden="true">
    <PawPrint/><PawPrint/><PawPrint/>
  </span>;
}

export function StoryEmblem() {
  return <div className="story-emblem" aria-hidden="true">
    <MoonStar className="story-moon"/>
    <span className="story-cat"><Cat/></span>
    <RibbonBow className="story-bow"/>
    <Sparkles className="story-sparkles"/>
    <PawTrail/>
  </div>;
}
