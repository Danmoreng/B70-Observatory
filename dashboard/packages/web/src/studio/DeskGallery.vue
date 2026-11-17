<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { images, annotate, media, duration, requestDelete, type ImageItem } from './desk.js';
import AppIcon from '../components/AppIcon.vue';
import ImageActions from './ImageActions.vue';
import { studioText as st, studioLabel } from './copy.js';
const emit = defineEmits<{
  count: [count: number];
  view: [image: ImageItem, collection: ImageItem[]];
  reuse: [image: ImageItem];
  edit: [image: ImageItem];
}>();
const query = new URLSearchParams(location.search),
  oldCategory = query.get('category') || 'all';
const search = ref(''),
  category = ref(oldCategory === 'Landschaften' ? 'Landscapes' : oldCategory),
  quantization = ref('all'),
  sort = ref(
    ['newest', 'oldest', 'largest', 'rating'].includes(query.get('sort') ?? '')
      ? query.get('sort')!
      : 'newest'
  ),
  date = ref('all');
const favorites = ref(false),
  minRating = ref(0);
const categories = computed(() => [...new Set(images.value.map((i) => i.category))].sort());
const filtered = computed(() => {
  const words = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return images.value
    .filter((image) => {
      const haystack = [
          image.title,
          image.prompt,
          image.seed,
          image.quantization,
          ...image.keywords,
        ]
          .join(' ')
          .toLocaleLowerCase(),
        timestamp = image.created * 1000;
      const matchesDate =
        date.value === 'all' ||
        (date.value === 'today' && timestamp >= today.getTime()) ||
        (date.value === 'yesterday' &&
          timestamp >= today.getTime() - 86400000 &&
          timestamp < today.getTime()) ||
        (date.value === 'week' && timestamp >= today.getTime() - 7 * 86400000) ||
        (date.value === 'month' && timestamp >= today.getTime() - 30 * 86400000);
      return (
        words.every((word) => haystack.includes(word)) &&
        (category.value === 'all' || image.category === category.value) &&
        (quantization.value === 'all' || image.quantization === quantization.value) &&
        (!favorites.value || image.favorite) &&
        image.rating >= minRating.value &&
        matchesDate
      );
    })
    .sort((a, b) =>
      a.pinned !== b.pinned
        ? a.pinned
          ? -1
          : 1
        : sort.value === 'oldest'
          ? a.created - b.created
          : sort.value === 'largest'
            ? b.width * b.height - a.width * a.height
            : sort.value === 'rating'
              ? b.rating - a.rating || b.created - a.created
              : b.created - a.created
    );
});

watch(
  () => filtered.value.length,
  (count) => emit('count', count),
  { immediate: true }
);
</script>
<template>
  <section :aria-label="st('Image gallery')">
    <div class="desk-gallery-filters island">
      <div class="desk-search">
        <AppIcon name="search" /><input
          v-model="search"
          class="form-control"
          type="search"
          :aria-label="st('Search images')"
          :placeholder="st('Search prompts, seeds or keywords…')"
        />
      </div>
      <select v-model="category" class="form-select" :aria-label="st('Image category')">
        <option value="all">{{ st('All collections') }}</option>
        <option v-for="c in categories" :key="c" :value="c">{{ studioLabel(c) }}</option>
      </select>
      <select v-model="quantization" class="form-select" :aria-label="st('Image model')">
        <option value="all">{{ st('All models') }}</option>
        <option>INT8</option>
        <option>W4A8</option>
      </select>
      <select v-model="sort" class="form-select" :aria-label="st('Sort images')">
        <option value="newest">{{ st('Newest first') }}</option>
        <option value="oldest">{{ st('Oldest first') }}</option>
        <option value="largest">{{ st('Largest first') }}</option>
        <option value="rating">{{ st('Highest rated') }}</option>
      </select>
      <select v-model="date" class="form-select" :aria-label="st('Date filter')">
        <option value="all">{{ st('All dates') }}</option>
        <option value="today">{{ st('Today') }}</option>
        <option value="yesterday">{{ st('Yesterday') }}</option>
        <option value="week">{{ st('Last 7 days') }}</option>
        <option value="month">{{ st('Last 30 days') }}</option>
      </select>
      <select v-model.number="minRating" class="form-select" :aria-label="st('Minimum rating')">
        <option :value="0">{{ st('Any rating') }}</option>
        <option v-for="n in 5" :key="n" :value="n">{{ st('{count}+ stars', { count: n }) }}</option>
      </select>
      <button
        class="btn btn-secondary"
        :class="{ active: favorites }"
        :aria-pressed="favorites"
        @click="favorites = !favorites"
      >
        <AppIcon name="heart" :filled="favorites" />{{ st('Favorites') }}
      </button>
    </div>
    <div v-if="!filtered.length" class="desk-empty island">
      <AppIcon name="gallery" />
      <h2>{{ st('No images in this view') }}</h2>
      <p>{{ st('Try another filter, or generate your first image.') }}</p>
    </div>
    <div class="desk-gallery-grid">
      <article v-for="image in filtered" :key="image.id" class="desk-image-card island">
        <button class="desk-card-image" @click="emit('view', image, filtered)">
          <img
            :src="media(image, 'thumb')"
            :alt="image.prompt || image.title"
            :width="image.width"
            :height="image.height"
            loading="lazy"
          /><span class="desk-card-quant">{{ image.quantization || st('Image') }}</span
          ><span v-if="image.pinned" class="desk-card-pin"
            ><AppIcon name="pin" :aria-label="st('Pinned')"
          /></span>
        </button>
        <div class="desk-card-info">
          <button class="desk-card-title" @click="emit('view', image, filtered)">
            {{ image.title }}</button
          ><small
            >{{ image.width }} × {{ image.height
            }}<template v-if="image.generationTime">
              · {{ duration(image.generationTime) }}</template
            ><span v-if="image.rating" class="desk-card-rating">{{
              '★'.repeat(image.rating)
            }}</span></small
          >
          <div class="desk-card-actions">
            <button
              class="btn btn-sm btn-secondary"
              :aria-label="st(image.favorite ? 'Remove from favorites' : 'Add to favorites')"
              :aria-pressed="image.favorite"
              @click="annotate(image, { favorite: !image.favorite })"
            >
              <AppIcon
                name="heart"
                :filled="image.favorite"
                :class="{ 'text-danger': image.favorite }"
              /></button
            ><ImageActions
              :image="image"
              compact
              @reuse="emit('reuse', $event)"
              @edit="emit('edit', $event)"
            /><button
              class="btn btn-sm btn-secondary text-danger ms-auto"
              :title="st('Delete image permanently')"
              :aria-label="st('Delete {title} permanently', { title: image.title })"
              @click="requestDelete(image)"
            >
              <AppIcon name="trash" />
            </button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
