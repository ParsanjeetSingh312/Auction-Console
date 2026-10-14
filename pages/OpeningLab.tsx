/**
 * OpeningLab.tsx
 * /lab/opening: the landing exactly as a first-time visitor gets it, with the
 * delivery opening (the ball's flight, PRESENTING TO YOU, the climb and the
 * drop onto the trophy). The same as `/`, except that it plays on every visit
 * and never marks the opening seen, so it can be reviewed again and again
 * without touching what `/` does. Nothing links here.
 */
import Auctiq from "./Auctiq";

export default function OpeningLab() {
  return <Auctiq opening="delivery" alwaysPlay />;
}
