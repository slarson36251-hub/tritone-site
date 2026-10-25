// Gig posters from the old site's gallery and band pages (reference/squarespace-archive).
// Captions only repeat what is printed on the poster. `bands` links a poster to band pages.
import type { ImageMetadata } from "astro";
import hardBop from "../assets/posters/hard-bop-quintet-club-deluxe-poster.jpg";
import slq from "../assets/posters/scott-larson-quartet-club-deluxe-poster.jpg";
import riteSpot from "../assets/posters/franco-nero-rite-spot-june-11-poster.jpg";
import dawnPenn from "../assets/posters/dawn-penn-franco-nero-uptown-oakland-poster.jpg";
import skatalites from "../assets/posters/norma-fraser-skatalites-franco-nero-uptown-poster.jpg";
import crescent from "../assets/posters/franco-nero-crescent-hotel-march-2011-poster.jpg";
import mashup from "../assets/posters/three-band-dub-mashup-make-out-room-poster.jpg";
import ivyRoom from "../assets/posters/dub-cember-holi-daze-ivy-room-poster.jpg";
import holidaze from "../assets/posters/holidaze-make-out-room-dec-2016-poster.jpg";
import otisGreen from "../assets/posters/return-of-otis-boom-boom-room-green-poster.jpg";
import otisRed from "../assets/posters/return-of-otis-boom-boom-room-red-poster.jpg";
import lucky7 from "../assets/photos/lucky-7-band-live.jpg";

export interface Poster {
  id: string;
  img: ImageMetadata;
  title: string;
  sub: string;
  alt: string;
  bands: string[];
}

export const posters: Poster[] = [
  {
    id: "hard-bop-quintet-club-deluxe",
    img: hardBop,
    title: "Hard Bop Quintet",
    sub: "Live at Club Deluxe",
    alt: "Hard Bop Quintet poster, Live at Club Deluxe: a trumpeter drawn in blue and gold against a cream background",
    bands: ["hard-bop-quintet"],
  },
  {
    id: "franco-nero-rite-spot",
    img: riteSpot,
    title: "Franco Nero!",
    sub: "Rite Spot · Saturday, June 11",
    alt: "Franco Nero! poster: big lettering in a starburst over orange and red rays, with R&B, Soul, Ska and Reggae around it",
    bands: ["franco-nero"],
  },
  {
    id: "dawn-penn-uptown",
    img: dawnPenn,
    title: "Dawn Penn, backed by Franco Nero",
    sub: "Uptown Nightclub, Oakland",
    alt: "Hand-lettered poster of Dawn Penn in a red jacket and hat, backed by Franco Nero, a sixties rocksteady revival set",
    bands: ["franco-nero"],
  },
  {
    id: "scott-larson-quartet-club-deluxe",
    img: slq,
    title: "Scott Larson Quartet",
    sub: "Club Deluxe · Saturday, May 28",
    alt: "Scott Larson Quartet poster: a trombone across red circles on a dark green background",
    bands: ["scott-larson-quartet"],
  },
  {
    id: "skatalites-uptown",
    img: skatalites,
    title: "Norma Fraser with the Skatalites, plus Franco Nero",
    sub: "The Uptown, Oakland · Friday, April 27",
    alt: "Poster in olive and pink: Norma Fraser with the Skatalites, plus Franco Nero, with three singers and a scooter",
    bands: ["franco-nero"],
  },
  {
    id: "three-band-dub-mashup",
    img: mashup,
    title: "3 Band Dub Mashup holiday show",
    sub: "Make-Out Room · Sunday, Dec. 13",
    alt: "Engraving-style poster of two gentlemen with animal heads shaking hands, holding a trombone and a trumpet, for a dub holiday show with Franco Nero",
    bands: ["franco-nero"],
  },
  {
    id: "franco-nero-crescent-hotel",
    img: crescent,
    title: "Franco Nero: a night of ska & rocksteady",
    sub: "Crescent Hotel, San Francisco · Saturday, March 12, 2011",
    alt: "Brown and yellow retro poster for a night of ska and rocksteady live sets from Franco Nero, with a dancing couple",
    bands: ["franco-nero"],
  },
  {
    id: "holidaze-make-out-room",
    img: holidaze,
    title: "Holidaze Extravaganza",
    sub: "Make Out Room · Sunday, Dec 11, 2016",
    alt: "Gold and magenta poster with showgirls and a dancer in a yellow coat: The Tritonics, Guerilla Hi-Fi, Joseph's Bones and Franco Nero",
    bands: ["franco-nero"],
  },
  {
    id: "dub-cember-ivy-room",
    img: ivyRoom,
    title: "Dub-cember Holi-Daze Party",
    sub: "Ivy Room · Sunday, December 10",
    alt: "Red poster with a trombonist silhouette made of text, Dub-cember Holi-Daze Party with Franco Nero",
    bands: ["franco-nero"],
  },
  {
    id: "return-of-otis-green",
    img: otisGreen,
    title: "The Return of Otis, plus Franco Nero",
    sub: "The Boom Boom Room · Friday, October 28",
    alt: "Green poster with giant yellow OTIS lettering: The Return of Otis, plus Franco Nero",
    bands: ["franco-nero"],
  },
  {
    id: "return-of-otis-red",
    img: otisRed,
    title: "The Return of Otis (red)",
    sub: "The Boom Boom Room · Friday, October 28",
    alt: "Orange-red poster with giant white OTIS lettering: The Return of Otis, plus Franco Nero",
    bands: ["franco-nero"],
  },
  {
    id: "lucky-7-live",
    img: lucky7,
    title: "Lucky 7",
    sub: "On stage",
    alt: "Lucky 7 on stage in sepia, trumpet, trombone and clarinet up front, upright bass and guitar behind",
    bands: ["lucky-7"],
  },
];

export const postersFor = (slug: string) => posters.filter((p) => p.bands.includes(slug));
