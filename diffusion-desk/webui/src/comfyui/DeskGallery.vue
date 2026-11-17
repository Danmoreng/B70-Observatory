<script setup lang="ts">
import { computed, ref } from 'vue'
import { images, annotate, media, duration, requestDelete, type ImageItem } from './desk'
const emit = defineEmits<{ view: [image: ImageItem, collection: ImageItem[]]; reuse: [image: ImageItem]; edit: [image: ImageItem] }>()
const query = new URLSearchParams(location.search)
const oldCategory = query.get('category') || 'all'
const search = ref(''), category = ref(oldCategory === 'Landschaften' ? 'Landscapes' : oldCategory), quantization = ref('all'), sort = ref(query.get('sort') || 'newest'), date = ref('all')
const favorites = ref(false), minRating = ref(0)
const categories = computed(() => [...new Set(images.value.map(i => i.category))].sort())
const filtered = computed(() => {
  const words = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  let result = images.value.filter(image => {
    const haystack = `${image.title} ${image.prompt} ${image.seed} ${image.quantization} ${image.keywords.join(' ')}`.toLocaleLowerCase()
    const timestamp = image.created * 1000
    const matchesDate = date.value === 'all' || (date.value === 'today' && timestamp >= today.getTime())
      || (date.value === 'yesterday' && timestamp >= today.getTime() - 86400000 && timestamp < today.getTime())
      || (date.value === 'week' && timestamp >= today.getTime() - 7 * 86400000)
      || (date.value === 'month' && timestamp >= today.getTime() - 30 * 86400000)
    return words.every(word => haystack.includes(word)) && (category.value === 'all' || image.category === category.value)
      && (quantization.value === 'all' || image.quantization === quantization.value) && (!favorites.value || image.favorite)
      && image.rating >= minRating.value && matchesDate
  })
  result = [...result].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (sort.value === 'oldest') return a.created - b.created
    if (sort.value === 'largest') return b.width * b.height - a.width * a.height
    if (sort.value === 'rating') return b.rating - a.rating || b.created - a.created
    if (sort.value === 'pair') return a.comparisonKey.localeCompare(b.comparisonKey) || (a.quantization === 'W4A8' ? -1 : 1)
    return b.created - a.created
  })
  return result
})
const entries = computed(() => {
  if (sort.value !== 'pair') return filtered.value.map(image => ({ key: image.id, image, missing: '' }))
  const groups = new Map<string, ImageItem[]>()
  for (const image of filtered.value) {
    if (!groups.has(image.comparisonKey)) groups.set(image.comparisonKey, [])
    groups.get(image.comparisonKey)!.push(image)
  }
  return [...groups.entries()].flatMap(([key, group]) => ['W4A8', 'INT8'].map(quant => ({
    key: key + '-' + quant, image: group.find(image => image.quantization === quant), missing: quant,
  })))
})
</script>

<template>
  <section aria-label="Image gallery">
    <div class="desk-gallery-filters island">
      <div class="desk-search"><i class="bi bi-search" aria-hidden="true"></i><input v-model="search" class="form-control" type="search" aria-label="Search images" placeholder="Search prompts, seeds or keywords…"></div>
      <select v-model="category" class="form-select" aria-label="Image category"><option value="all">All collections</option><option v-for="c in categories" :key="c">{{ c }}</option></select>
      <select v-model="quantization" class="form-select" aria-label="Image model"><option value="all">All models</option><option>INT8</option><option>W4A8</option></select>
      <select v-model="sort" class="form-select" aria-label="Sort images"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="largest">Largest first</option><option value="rating">Highest rated</option><option value="pair">Matched pairs</option></select>
      <select v-model="date" class="form-select" aria-label="Date filter"><option value="all">All dates</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">Last 7 days</option><option value="month">Last 30 days</option></select>
      <select v-model.number="minRating" class="form-select" aria-label="Minimum rating"><option :value="0">Any rating</option><option v-for="n in 5" :key="n" :value="n">{{ n }}+ stars</option></select>
      <button class="btn" :class="favorites ? 'btn-primary' : 'btn-secondary'" :aria-pressed="favorites" @click="favorites = !favorites"><i class="bi" :class="favorites ? 'bi-heart-fill' : 'bi-heart'" aria-hidden="true"></i> Favorites</button>
    </div>
    <div class="desk-gallery-summary"><span>{{ filtered.length }} {{ filtered.length === 1 ? 'image' : 'images' }}</span><span>{{ sort === 'pair' ? 'W4A8 on the left · INT8 on the right' : 'Tap an image to view, download or reuse its settings.' }}</span></div>
    <div v-if="!filtered.length" class="desk-empty island"><i class="bi bi-images" aria-hidden="true"></i><h2>No images in this view</h2><p>Try another filter, or generate your first image.</p></div>
    <div class="desk-gallery-grid" :class="{ 'pair-view': sort === 'pair' }">
      <template v-for="entry in entries" :key="entry.key">
      <article v-if="entry.image" class="desk-image-card island">
        <template v-for="image in [entry.image]" :key="image.id">
        <button class="desk-card-image" @click="emit('view', image, filtered)"><img :src="media(image, 'thumb')" :alt="image.prompt || image.title" :width="image.width" :height="image.height" loading="lazy"><span class="desk-card-quant">{{ image.quantization || 'Image' }}</span><span v-if="image.pinned" class="desk-card-pin"><i class="bi bi-pin-angle-fill" aria-label="Pinned"></i></span></button>
        <div class="desk-card-info">
          <button class="desk-card-title" @click="emit('view', image, filtered)">{{ image.title }}</button>
          <small>{{ image.width }} × {{ image.height }}<template v-if="image.generationTime"> · {{ duration(image.generationTime) }}</template><span v-if="image.rating" class="desk-card-rating">{{ '★'.repeat(image.rating) }}</span></small>
          <div class="desk-card-actions">
            <button class="btn btn-sm btn-secondary" :aria-label="image.favorite ? 'Remove from favorites' : 'Add to favorites'" :aria-pressed="image.favorite" @click="annotate(image, { favorite: !image.favorite })"><i class="bi" :class="image.favorite ? 'bi-heart-fill text-danger' : 'bi-heart'" aria-hidden="true"></i></button>
            <button class="btn btn-sm btn-secondary" @click="emit('reuse', image)">Reuse</button>
            <button class="btn btn-sm btn-secondary" title="Edit image" aria-label="Edit image" @click="emit('edit', image)"><i class="bi bi-pencil-square" aria-hidden="true"></i></button>
            <a class="btn btn-sm btn-secondary ms-auto" :href="media(image, 'original', true)" download :aria-label="`Download ${image.title}`"><i class="bi bi-download" aria-hidden="true"></i></a>
            <button class="btn btn-sm btn-secondary text-danger" title="Delete image permanently" :aria-label="`Delete ${image.title} permanently`" @click="requestDelete(image)"><i class="bi bi-trash" aria-hidden="true"></i></button>
          </div>
        </div>
        </template>
      </article>
      <div v-else class="desk-pair-placeholder island"><i class="bi bi-image" aria-hidden="true"></i><span>No {{ entry.missing }} version in this view</span></div>
      </template>
    </div>
  </section>
</template>
