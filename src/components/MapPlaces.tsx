import { useEffect, useReducer, useContext, useState } from 'react'
import { IdentityContextType, IdentityType } from '../types/IdentityType'
import { IdentityContext } from '../providers/IdentityProvider'
import { ModalContextType } from '../types/ModalType'
import { ModalContext } from '../providers/ModalProvider'
import { Event, Filter } from 'nostr-tools'
import { getRelayList, pool } from "../libraries/Nostr"
import { useGeolocationData } from "../hooks/useGeolocationData"
import { useMap } from 'react-map-gl'
import { Marker } from 'react-map-gl'
import { DraftPlaceContext } from '../providers/DraftPlaceProvider'
import { DraftPlaceContextType, EventWithoutContent, Place, PlaceProperties } from '../types/Place'
import { RelayList } from '../types/NostrRelay'
import { getTag } from "../libraries/Nostr"
import { Beacon } from './Beacon'
import '../scss//MapPlaces.scss'
import { ContactList } from '../types/NostrContact'

const getUniqueBeaconID = (beacon: Place) => {
  const dtag = beacon.tags.find(getTag("d"))
  const dtagValue = dtag?.[1]
  const pubkey = beacon.pubkey
  const kind = beacon.kind
  return `${dtagValue}-${pubkey}-${kind}`
}

type beaconsReducerType = {
  [key: string]: Place
}

const beaconsReducer = (state: beaconsReducerType, action: { type: string; beacon?: Place }) => {

  if (action.beacon) {
    const unique = getUniqueBeaconID(action?.beacon)
    const existing = state[unique]
    // only save the newest beacon by created_at timestamp; if this incoming beacon s older, don't save it.
    if (existing && existing.created_at > action.beacon.created_at) return state

    if (action.type === 'add') {
      return {
        ...state,
        [unique]: action.beacon  
      }
    }
  }

  // proceed with save
  switch(action.type) {
    case 'clear':
      return {}
    default:
      return state
  }
}

type Owner = Event & { content: IdentityType }
type beaconOwnersReducerType = {
  [key: string]: Owner
} 

const beaconOwnersReducer = (state: beaconOwnersReducerType, action: { type: string; owner?: Owner}) => {
  if (action.owner && action.owner.pubkey) {
    const unique = action.owner.pubkey
    if (action.type === 'add') {
      return {
        ...state,
        [unique]: action.owner
      }
    }
  }

  // proceed with save
  switch(action.type) {
    case 'clear':
      return {}
    default:
      return state
  }
}

type beaconsStateReducerType = string[]

const beaconsStateReducer = (state: beaconsStateReducerType, action: { type: string; beacon: Place }) => {
  // when a beacon is toggled open, put its unique ID at the front of the state array; the first beacon is rendered on top.
  // when a beacon is toggled closed, remove its unique ID from the state array.
  const unique = getUniqueBeaconID(action.beacon)
  switch(action.type) {
    case 'add': 
      return [
        unique,
        ...state.filter( (id) => id !== unique )
      ]
    case 'remove':
      return [
        ...state.filter( (id) => id !== unique )
      ]
    default:
      return state
  }
}

export const MapPlaces = ({global}: {global: boolean}) => {
  const [beacons, beaconsDispatch] = useReducer(beaconsReducer, {})
  const [gotAllBeacons, setGotAllBeacons] = useState(false)
  const [beaconOwners, beaconOwnersDispatch] = useReducer(beaconOwnersReducer, {})
  const [beaconsToggleState, setBeaconsToggleState] = useReducer(beaconsStateReducer, [])
  const {position} = useGeolocationData()
  const {current: map} = useMap()
  const {identity, relays, contacts} = useContext<IdentityContextType>(IdentityContext)
  const {modal} = useContext<ModalContextType>(ModalContext)
  const {draftPlace, setDraftPlace} = useContext<DraftPlaceContextType>(DraftPlaceContext)

  // get all beacons
  useEffect( () => {
    beaconsDispatch({type: 'clear'})
    const contactList: ContactList = [identity.pubkey, ...Object.keys(contacts || {}) ]
    const filter: Filter<37515> = global ? {kinds: [37515]} : {kinds: [37515], authors: contactList}
    const relayList: RelayList = getRelayList(relays, ['read'])
    const sub = pool.sub(relayList, [filter])
    // get places from your relays
    sub.on('event', (event) => {
      let placeProperties: PlaceProperties
      try {
        placeProperties = JSON.parse(event.content)
        if (!placeProperties.geometry || !placeProperties.geometry.coordinates) throw new Error('No coordinates')
        // if any events have malformed coordinates using an object with lat or lng properties, convert them to array/mapbox format
        if (!Array.isArray(placeProperties.geometry.coordinates)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const {lng, lat} = placeProperties.geometry.coordinates as any
          const lngLatArray: [number, number] = [lng, lat]
          placeProperties.geometry.coordinates = lngLatArray
        }
        const foundEvent: EventWithoutContent = {
          ... event
        }
        const place: Place = {
          ... foundEvent,
          content: placeProperties as PlaceProperties
        }

        beaconsDispatch({
          type: 'add',
          beacon: place 
        })
      } catch (e) {
        console.log('Failed to parse event content:', e)
      }
    })
    sub.on('eose', () => {
      setGotAllBeacons(true)
      sub.unsub()
    })
    return () => {
      sub.unsub()
    }
  }, [relays,global,contacts,identity])

  // get all beacon owner profiles
  // NOTE: some beacon owners won't have profiles! They simply haven't published one yet!
  useEffect( () => {
    const beaconPubkeys: {[key: string]: boolean} = {} 
    Object.values(beacons).forEach( beacon => {
      beaconPubkeys[beacon.pubkey] = true
    })
    const beaconOwnerList = Object.keys(beaconPubkeys)
    const profileFilter: Filter = { kinds: [0], authors: beaconOwnerList }
    const relayList: RelayList = getRelayList(relays, ['read'])
    const sub = pool.sub(relayList, [profileFilter])
    sub.on('event', (event) => {
      try {
        beaconOwnersDispatch({
          type: 'add',
          owner: {
            ...event,
            content: JSON.parse(event.content)
          }
        })
      } catch(e) {
        console.log('Failed to parse event content:', e)
      }
    })
    sub.on('eose', () => {
      setGotAllBeacons(true)
      sub.unsub()
    })
    return () => {
      sub.unsub()
    }
  }, [gotAllBeacons])

  const beaconsArray = Object.values(beacons)

  beaconsArray
    // Sort first by the first elements in beaconToggleState, then by oldest to newest.
    .sort( (a, b) => {
      const aIndex = beaconsToggleState.indexOf(getUniqueBeaconID(a))
      const bIndex = beaconsToggleState.indexOf(getUniqueBeaconID(b))
      if (aIndex === -1 && bIndex === -1) {
        // neither is in the toggle state, sort by newest to oldest
        return b.created_at - a.created_at
      } else if (aIndex === -1) {
        // a is not in the toggle state, sort it below b
        return 1
      } else if (bIndex === -1) {
        // b is not in the toggle state, sort it below a
        return -1
      } else {
        // both are in the toggle state, sort by their index in the toggle state
        return aIndex - bIndex
      }
    }).reverse()

  // console.log(beaconsArray.map( b => getUniqueBeaconID(b).split('-')[0]))

  // iterate through beacon data and prepare it for map display. 
  return beaconsArray 
    // convert each beacon into a JSX Beacon Component
    .map( (beacon: Place ) => {
      // move map so the beacon is left of the details box
      const handleFollow = () => {
        if (map && position) {
          map.flyTo({
            center: [beacon.content.geometry.coordinates[0] + 0.00135, beacon.content.geometry.coordinates[1]],
            zoom: 16,
            duration: 1000,
          })
        }
      }
      // move map so the beacon is above the edit form
      const handleEdit = () => {
        if (map && position) {
          map.flyTo({
            center: [beacon.content.geometry.coordinates[0], beacon.content.geometry.coordinates[1] - 0.0010],
            zoom: 16,
            duration: 1000,
          })
        }
      }
      return (
        <Marker clickTolerance={5} key={beacon.id} longitude={beacon.content.geometry.coordinates[0]} latitude={beacon.content.geometry.coordinates[1]} offset={[-20,-52]} anchor={'center'}>
          <Beacon
            currentUserPubkey={identity?.pubkey}
            ownerProfile={beaconOwners[beacon.pubkey]}
            relays={relays}
            modal={modal}
            beaconData={beacon}
            toggleHandler={setBeaconsToggleState}
            clickHandler={handleFollow}
            editHandler={handleEdit}
            draft={{
              draftPlace,
              setDraftPlace
            }} 
            />
        </Marker>
      )
    })
}
