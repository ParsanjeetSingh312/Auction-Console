/**
 * IntroLab.tsx
 * /lab/intro: the stadium opening on its own, for review before it is wired
 * into the landing. Nothing links here.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";

import StadiumIntro from "../components/Intro/StadiumIntro";

export default function IntroLab() {
  useEffect(() => {
    document.title = "Opening · AUCTONIQ lab";
  }, []);

  return (
    <div className="auctiq">
      <StadiumIntro replayable>
        <Link to="/" className="intro-button intro-button--primary inline-flex items-center">
          Continue to the site
        </Link>
      </StadiumIntro>
    </div>
  );
}
