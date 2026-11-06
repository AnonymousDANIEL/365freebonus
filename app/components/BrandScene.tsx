export default function BrandScene({ coverImageUrl }: { coverImageUrl: string }) {
  return (
    <div className="brand-scene">
      <div className="brand-scene-halo" aria-hidden="true" />
      <div className="brand-scene-image">
        <img src={coverImageUrl} alt="" fetchPriority="high" draggable={false} />
      </div>
    </div>
  );
}
